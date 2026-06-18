import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import { type CoreEvent, type Layout, PROTOCOL_VERSION } from '@trainframe/protocol';
import {
  MqttBrokerClient as ServerBrokerClient,
  Server as TrainframeServer,
} from '@trainframe/server';
import {
  type LoopMarker,
  type MarkerPoint,
  PhysicsWorld,
  type RailNetwork,
  ScheduledTrainDevice,
  MqttBrokerClient as SimBrokerClient,
  SwitchDevice,
  buildBranchingScene,
  mqttPlatform,
  physicsMarkerSensor,
  physicsMotorActuator,
  physicsSwitchActuator,
  sceneToLayout,
  straightLoop,
} from '@trainframe/simulator';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

type AedesBroker = Awaited<ReturnType<typeof Aedes.createBroker>>;

/** A switch device the harness registers with the world + bus so the scheduler
 *  can throw it (a diverge junction). */
interface UiSwitch {
  readonly deviceId: string;
  readonly switchLabel: string;
  readonly junctionMarkerId: string;
  readonly positions: readonly string[];
}

/**
 * A drivable scene for the harness: a physics `net`, the matching server
 * `Layout`, each marker's world point (for the sensors), a `placeAt` that maps a
 * marker to where a body is seeded on the net, and any switch devices to register.
 */
export interface UiScene {
  readonly net: RailNetwork;
  readonly layout: Layout;
  readonly points: readonly MarkerPoint[];
  placeAt(markerId: string): { segment: string; railPos: number };
  readonly switches: readonly UiSwitch[];
  readonly segmentLayer?: ReadonlyMap<string, number>;
}

/** Build a single-rail LOOP scene from a cyclic `Layout`'s markers — the common
 *  case (the operator's running ring). Every marker sits on the one 'main'
 *  segment, so a body is seeded at the marker's world x. */
function loopUiScene(markers: readonly LoopMarker[]): UiScene {
  const scene = straightLoop(markers);
  const byId = new Map(scene.markers.map((m) => [m.id, m]));
  return {
    net: scene.net,
    layout: scene.layout,
    points: scene.markers,
    placeAt: (markerId) => ({ segment: 'main', railPos: byId.get(markerId)?.x ?? 0 }),
    switches: [],
  };
}

/**
 * The branching scene (main ring + scenic BRANCH off the `Jspur` diverge) as a
 * harness scene. Used by the operator-built-route journey: the operator picks a
 * branch stop and the planner must route through `M-spur` (Jspur='branch') onto
 * the branch — a path a trivial first-edge walk never takes.
 */
export function buildBranchingUiScene(): UiScene {
  const scene = buildBranchingScene();
  const layout = sceneToLayout(scene, 'branching');
  const points: MarkerPoint[] = scene.markers.map((m) => {
    const rail = scene.net.railOf(m.segment);
    const d = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
    const p = rail.at(d);
    return { id: m.id, x: p.x, y: p.y };
  });
  const placeAt = (markerId: string): { segment: string; railPos: number } => {
    const m = scene.markers.find((mk) => mk.id === markerId);
    if (m === undefined) throw new Error(`buildBranchingUiScene: no marker ${markerId}`);
    const rail = scene.net.railOf(m.segment);
    const railPos = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
    return { segment: m.segment, railPos: Math.max(20, Math.min(rail.length - 20, railPos)) };
  };
  return {
    net: scene.net,
    layout,
    points,
    placeAt,
    switches: [
      {
        deviceId: 'SPUR',
        switchLabel: 'Jspur',
        junctionMarkerId: 'M-spur',
        positions: ['thru', 'branch'],
      },
    ],
  };
}

export interface SpawnTrainOptions {
  /** Marker the loco starts on. Defaults to the layout's first marker. */
  readonly atMarker?: string;
  /** Convenience: the `from_marker_id` is taken as `atMarker` (the old
   *  startEdge-shaped call site). */
  readonly startEdge?: { readonly from_marker_id: string; readonly to_marker_id: string };
  /** Heading along the rail (+1 forward / -1 reverse). Default +1. */
  readonly facing?: 1 | -1;
  /** Physical nose-to-tail length (mm). Default 120. */
  readonly lengthMm?: number;
}

export interface UiHarness {
  readonly brokerWsUrl: string;
  readonly server: TrainframeServer;
  /**
   * Spawn a physics train on the harness scene: adds a body to the world and a
   * `ScheduledTrainDevice` wired to the broker. The device registers and emits
   * its home marker on the first `advance`, so the visualiser places the icon; it
   * then responds to scheduler commands (assign_route, grant_clearance) and emits
   * marker crossings as it moves. Throws in discovery mode (no scene to spawn on).
   */
  spawnTrain(deviceId: string, options?: SpawnTrainOptions): void;
  /** Advance the physics world + every train device by `ms` virtual milliseconds.
   *  Device events reach the broker asynchronously; the visualiser sees them on
   *  the next WebSocket flush (poll with a deadline, as the specs do). */
  advance(ms: number): void;
  shutdown(): Promise<void>;
}

export interface UiHarnessOptions {
  /** A cyclic layout the server reasons against; the harness builds a matching
   *  single-rail loop scene to drive trains on. Mutually exclusive with `scene`
   *  and `discovery`. */
  readonly layout?: Layout;
  /** A pre-built scene (e.g. `buildBranchingUiScene()`) for non-loop topologies. */
  readonly scene?: UiScene;
  /** Boot the server in discovery mode: empty layout, no device layer (events are
   *  injected by the test or produced by the browser sim). */
  readonly discovery?: boolean;
  /** WebSocket port for the broker. Defaults to 9001 (matches the UI's default). */
  readonly wsPort?: number;
}

const DISCOVERY_LAYOUT: Layout = {
  name: 'discovery',
  markers: [],
  edges: [],
  junctions: [],
};

/** Physics tick (s): one 60 Hz frame, matching the demos' pump. */
const DT = 1 / 60;

/**
 * Boots an aedes broker over WebSockets, runs a real `@trainframe/server` against
 * it, and — unless in discovery mode — wires a real `PhysicsWorld` + physics
 * devices to the SAME broker via a second `MqttBrokerClient`. The harness gives
 * tests:
 *
 *   - a working broker the simulator-ui and visualiser can connect to
 *   - a real server with the admin HTTP routes (tag/route/gate)
 *   - a manually-advanced physics device layer (trains, switches) that supplies
 *     the marker reads + switch confirmations the scheduler expects
 *
 * The world doesn't auto-tick — tests call `harness.advance(ms)` to drive it.
 */
export async function startUiHarness(opts: UiHarnessOptions): Promise<UiHarness> {
  const uiScene = resolveScene(opts);
  const serverLayout = uiScene?.layout ?? DISCOVERY_LAYOUT;

  const broker = await Aedes.createBroker();
  const { httpServer, wsPort } = await listenWebSocketBroker(broker, opts.wsPort ?? 9001);
  const brokerWsUrl = `ws://127.0.0.1:${wsPort}`;

  const serverClient = new ServerBrokerClient();
  await serverClient.connect(brokerWsUrl);
  const server = new TrainframeServer({ layout: serverLayout, client: serverClient });
  server.start();

  /* Virtual clock: device timestamps advance with `advance(ms)`, deterministic
   *  and monotonic (no Date.now in the device path). */
  let clockMs = 0;
  let seq = 0;
  const newId = (): string => {
    seq += 1;
    return `uihar-${seq}`;
  };
  const nowIso = (): string => new Date(clockMs).toISOString();

  const teardown: Array<() => void> = [];
  let simClient: SimBrokerClient | undefined;
  let world: PhysicsWorld | undefined;
  const trains: ScheduledTrainDevice[] = [];

  if (uiScene !== undefined) {
    simClient = new SimBrokerClient();
    simClient.connect(brokerWsUrl);
    /* Identity tags so the server resolves each `tag_observed` to a
     *  `marker_traversed` (the GARAGE device with `core.assigns_tags`). */
    seedIdentityTags(
      simClient,
      uiScene.layout.markers.map((m) => m.id),
      newId,
      nowIso,
    );
    world = new PhysicsWorld(uiScene.net);
    for (const sw of uiScene.switches) {
      const device = new SwitchDevice(sw.deviceId, {
        platform: mqttPlatform(simClient, sw.deviceId, { newId, now: nowIso }),
        actuator: physicsSwitchActuator(world, sw.switchLabel),
        junctionMarkerId: sw.junctionMarkerId,
        positions: sw.positions,
        newId,
        now: nowIso,
      });
      device.start();
      teardown.push(() => device.stop());
    }
  }

  return {
    brokerWsUrl,
    server,
    spawnTrain(deviceId, options) {
      if (uiScene === undefined || world === undefined || simClient === undefined) {
        throw new Error('startUiHarness: spawnTrain needs a `layout` or `scene` (not discovery)');
      }
      const atMarker =
        options?.atMarker ?? options?.startEdge?.from_marker_id ?? uiScene.layout.markers[0]?.id;
      if (atMarker === undefined) throw new Error('spawnTrain: no marker to start on');
      const { segment, railPos } = uiScene.placeAt(atMarker);
      world.addBody({
        id: deviceId,
        kind: 'loco',
        segment,
        railPos,
        facing: options?.facing ?? 1,
      });
      const device = new ScheduledTrainDevice(deviceId, {
        platform: mqttPlatform(simClient, deviceId, { newId, now: nowIso }),
        motor: physicsMotorActuator(world, deviceId),
        sensor: physicsMarkerSensor(
          world,
          deviceId,
          [...uiScene.points],
          undefined,
          uiScene.segmentLayer,
        ),
        layout: uiScene.layout,
        lengthMm: options?.lengthMm ?? 120,
        canReverse: true,
        newId,
        now: nowIso,
      });
      device.start();
      trains.push(device);
      teardown.push(() => device.stop());
    },
    advance(ms: number) {
      if (world === undefined) return;
      const ticks = Math.max(1, Math.round(ms / (DT * 1000)));
      for (let i = 0; i < ticks; i++) {
        world.step(DT);
        for (const train of trains) train.step(DT);
        clockMs += DT * 1000;
      }
    },
    async shutdown() {
      for (const off of teardown) off();
      server.stop();
      if (simClient !== undefined) simClient.disconnect();
      await serverClient.disconnect();
      await closeBroker(broker);
      await closeHttpServer(httpServer);
    },
  };
}

function resolveScene(opts: UiHarnessOptions): UiScene | undefined {
  if (opts.scene !== undefined) return opts.scene;
  if (opts.layout !== undefined) {
    return loopUiScene(opts.layout.markers.map((m) => ({ id: m.id, kind: m.kind })));
  }
  if (opts.discovery === true) return undefined;
  throw new Error('startUiHarness: provide one of `layout`, `scene`, or `discovery: true`');
}

/** Mint one `tag_assignment` per marker via a synthetic GARAGE device, so the
 *  scheduler resolves `tag_observed` → `marker_traversed`. */
function seedIdentityTags(
  client: SimBrokerClient,
  markerIds: readonly string[],
  newId: () => string,
  now: () => string,
): void {
  if (markerIds.length === 0) return;
  const garage = mqttPlatform(client, 'GARAGE', { newId, now });
  garage.register({
    manifest_version: '1.0',
    vendor: 'trainframe.sim',
    device_kind: 'tag-garage',
    version: '0.1.0',
    protocol_version: PROTOCOL_VERSION,
    display_name: 'Tag garage',
    description: 'Mints identity tag assignments for the harness layout.',
    capabilities: ['core.assigns_tags'],
  });
  garage.publish(tagEvent('device_registered', { capabilities: ['core.assigns_tags'] }));
  for (const id of markerIds) {
    garage.publish(
      tagEvent('tag_assignment', { tag_id: id, assigned_kind: 'marker', target_id: id }),
    );
  }
}

/** A bare GARAGE event for the platform to publish. The open envelope is sound on
 *  the wire (the broker re-encodes JSON); coerced to `CoreEvent` once, here. */
function tagEvent(eventType: CoreEvent['event_type'], payload: Record<string, unknown>): CoreEvent {
  return { event_type: eventType, payload } as unknown as CoreEvent;
}

async function listenWebSocketBroker(
  broker: AedesBroker,
  port: number,
): Promise<{ httpServer: HttpServer; wsPort: number }> {
  const httpServer = createHttpServer();
  // The MQTT-over-WS spec requires the WebSocket subprotocol "mqtt"
  // (or legacy "mqttv3.1"); browsers send it in the handshake. Without
  // acknowledging it some clients refuse the connection, so we explicitly
  // select whichever the client offered.
  const wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: (protocols) => {
      for (const p of protocols) if (p === 'mqtt' || p === 'mqttv3.1') return p;
      return false;
    },
  });
  wss.on('connection', (ws) => {
    const stream = createWebSocketStream(ws, { allowHalfOpen: false });
    broker.handle(stream);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { httpServer, wsPort: actualPort };
}

function closeBroker(broker: AedesBroker): Promise<void> {
  return new Promise((resolve) => {
    broker.close(() => resolve());
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
