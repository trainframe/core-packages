/**
 * Physics test environment — the replacement for the old `startTestEnvironment`
 * (which drove the deleted virtual-device sim). It wires a REAL `@trainframe/server`
 * scheduler to a REAL `InMemoryBrokerClient`, and populates it with REAL physics
 * devices (`ScheduledTrainDevice`, `GateDevice`, `SwitchDevice`, …) running on a
 * REAL `PhysicsWorld`. Nothing is mocked: tests drive the system through events +
 * commands over the broker and observe outcomes (the Kent C. Dodds seam).
 *
 * The in-memory broker dispatches SYNCHRONOUSLY, and the server's clock is wired to
 * the env's virtual clock, so `advance(ms)` is deterministic and complete: every
 * effect of an `assign_schedule` / gate hold / marker crossing has landed by the
 * time it returns — no real-time waits, no polling. Seed a fixed marker geometry,
 * spawn devices, advance the clock, assert on the captured events/commands.
 *
 * Geometry is supplied per-test. `straightLoop(...)` is the cheap default: markers
 * strung along one straight rail closed into a loop (most focused scheduler tests
 * need only marker topology + timing, not curves). A test that needs junctions can
 * pass any `RailNetwork` + matching `Layout` instead.
 */
import {
  type CoreEvent,
  type Layout,
  type LayoutMarker,
  PROTOCOL_VERSION,
} from '@trainframe/protocol';
import { Server } from '@trainframe/server';
import { InMemoryBrokerClient } from './broker/in-memory-client.js';
import { mqttPlatform } from './broker/mqtt-platform.js';
import { GateDevice } from './devices/gate-device.js';
import { ScheduledTrainDevice } from './devices/scheduled-train-device.js';
import { SwitchDevice } from './devices/switch-device.js';
import { type RailNetwork, buildNetwork } from './physics/network.js';
import type { Rail } from './physics/rail.js';
import { PhysicsWorld } from './physics/world.js';
import { physicsMarkerSensor } from './sim/marker-sensor.js';
import { physicsMotorActuator } from './sim/motor-actuator.js';
import { physicsSwitchActuator } from './sim/switch-actuator.js';

/** A marker placed in the world (id + position the sensor reads). */
export interface MarkerPoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** The geometry a test runs on: a physics network, its matching server `Layout`,
 *  and where each marker sits in the world (for the marker sensors). */
export interface PhysicsScene {
  readonly net: RailNetwork;
  readonly layout: Layout;
  readonly markers: readonly MarkerPoint[];
  /** Optional segment→height-layer map. Supply it (with layered `markers`) for a
   *  grade-separated scene so a body under a deck ignores the deck's markers. */
  readonly segmentLayer?: ReadonlyMap<string, number>;
}

/** One marker on a `straightLoop` (id + the logical kind the scheduler sees). */
export interface LoopMarker {
  readonly id: string;
  readonly kind: LayoutMarker['kind'];
}

function straightRail(length: number): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

/**
 * Build a closed single-rail LOOP carrying `markers` evenly spaced `spacingMm`
 * apart, with cyclic edges `markers[i] → markers[i+1] → … → markers[0]`. One
 * 'main' segment linked end→start, so a forward-running train cycles forever.
 * Marker `i` sits at world x = `i * spacingMm`; the loop's circumference is
 * `markers.length * spacingMm` so crossing the last marker rolls back onto the
 * first. The returned `Layout` agrees with the geometry edge-for-edge.
 */
export function straightLoop(
  markers: readonly LoopMarker[],
  opts?: { readonly spacingMm?: number; readonly name?: string },
): PhysicsScene {
  const spacing = opts?.spacingMm ?? 500;
  const circumference = markers.length * spacing;
  const net = buildNetwork(new Map([['main', straightRail(circumference)]]), [
    { from: 'main', to: 'main' },
  ]);
  const points: MarkerPoint[] = markers.map((m, i) => ({ id: m.id, x: i * spacing, y: 0 }));
  const layout: Layout = {
    name: opts?.name ?? 'loop',
    markers: markers.map((m, i) => ({
      id: m.id,
      kind: m.kind,
      position: { x_mm: i * spacing, y_mm: 0 },
    })),
    edges: markers.map((m, i) => ({
      from_marker_id: m.id,
      to_marker_id: markers[(i + 1) % markers.length]?.id ?? m.id,
      estimated_length_mm: spacing,
    })),
    junctions: [],
  };
  return { net, layout, markers: points };
}

export interface SpawnTrainOptions {
  /** Which marker the loco's nose starts at (default: the layout's first marker). */
  readonly atMarker?: string;
  /**
   * Segment the body is seeded on. Defaults to `'main'` (the single-segment
   * `straightLoop` rail). A multi-segment net (e.g. a `compileNetwork` layout)
   * must pass the marker's real segment — paired with `railPos`.
   */
  readonly segment?: string;
  /** Distance along `segment` the body starts at (mm). Defaults to the marker's
   *  world x (correct only for the single-rail `straightLoop`). */
  readonly railPos?: number;
  /** Heading along the rail (+1 forward / -1 reverse). Default +1. */
  readonly facing?: 1 | -1;
  /** Declares `core.can_reverse` (a zone-admission prerequisite). Default true. */
  readonly canReverse?: boolean;
  /** Physical nose-to-tail length (mm). Default 120. */
  readonly lengthMm?: number;
  /** Body top speed (mm/s) in the world. Default 400. */
  readonly maxSpeed?: number;
}

export interface SpawnGateOptions {
  /** Markers this gate may withhold. */
  readonly markers: readonly string[];
  /** Markers held from the moment it registers (a gate that starts closed). */
  readonly initialWithheld?: readonly string[];
}

export interface SpawnSwitchOptions {
  /** The junction marker this device owns. */
  readonly junctionMarkerId: string;
  /** The physics switch label in the network the actuator throws. */
  readonly switchLabel: string;
  /** Valid positions (e.g. `['thru','branch']`). */
  readonly positions: readonly string[];
}

export interface CapturedEvent {
  readonly at_ms: number;
  readonly event_type: string;
  readonly device_id: string;
  readonly payload: Record<string, unknown>;
}

export interface CapturedCommand {
  readonly at_ms: number;
  readonly command_type: string;
  readonly device_id: string;
  readonly payload: Record<string, unknown>;
}

export interface PhysicsEnv {
  readonly world: PhysicsWorld;
  readonly server: Server;
  readonly client: InMemoryBrokerClient;
  /** Every event seen on `railway/events/+/+`, in arrival order. */
  readonly events: ReadonlyArray<CapturedEvent>;
  spawnTrain(trainId: string, options?: SpawnTrainOptions): ScheduledTrainDevice;
  spawnGate(deviceId: string, options: SpawnGateOptions): GateDevice;
  spawnSwitch(deviceId: string, options: SpawnSwitchOptions): SwitchDevice;
  assignSchedule(trainId: string, stops: readonly string[], routeId?: string): void;
  /** Advance the world + every device + the scheduler clock in lockstep by `ms`. */
  advance(ms: number): void;
  /** Commands the scheduler sent to `deviceId`, in order. */
  commandsFor(deviceId: string): ReadonlyArray<CapturedCommand>;
  eventsOfType(eventType: string): ReadonlyArray<CapturedEvent>;
  shutdown(): void;
}

/** Physics tick (s): one 60 Hz frame, matching the demos' pump. */
const DT = 1 / 60;

export function startPhysicsEnv(scene: PhysicsScene): PhysicsEnv {
  /* The simulator's in-memory broker is the single synchronous bus. It satisfies
   *  the simulator `BrokerClient` (what `mqttPlatform` wants); the server's
   *  `BrokerClient` differs only in returning promises from connect/disconnect, so
   *  we hand the server a thin promise-facade over the SAME bus. */
  const bus = new InMemoryBrokerClient();
  const serverClient = {
    connect: async (): Promise<void> => {},
    disconnect: async (): Promise<void> => {},
    subscribe: (topic: string, handler: Parameters<InMemoryBrokerClient['subscribe']>[1]) =>
      bus.subscribe(topic, handler),
    publish: (...args: Parameters<InMemoryBrokerClient['publish']>) => bus.publish(...args),
  };

  let clockMs = 0;
  let seq = 0;
  const newId = (): string => {
    seq += 1;
    return `env-${seq}`;
  };
  const now = (): number => clockMs;
  const nowIso = (): string => new Date(clockMs).toISOString();

  const events: CapturedEvent[] = [];
  bus.subscribe('railway/events/+/+', (message) => {
    const env = decodeJson(message.payload);
    if (env === null) return;
    const parts = message.topic.split('/');
    const eventType = parts[2];
    const deviceFromTopic = parts[3];
    if (eventType === undefined || deviceFromTopic === undefined) return;
    events.push({
      at_ms: clockMs,
      event_type: eventType,
      device_id: typeof env.device_id === 'string' ? env.device_id : deviceFromTopic,
      payload: asRecord(env.payload),
    });
  });

  const commands: CapturedCommand[] = [];
  bus.subscribe('railway/commands/+', (message) => {
    const env = decodeJson(message.payload);
    if (env === null || typeof env.command_type !== 'string') return;
    commands.push({
      at_ms: clockMs,
      command_type: env.command_type,
      device_id: message.topic.split('/').pop() ?? '',
      payload: asRecord(env.payload),
    });
  });

  const server = new Server({ layout: scene.layout, client: serverClient, newId, now });
  server.start();

  /* Seed identity tags AFTER the server is subscribed: a synthetic GARAGE device
   *  with `core.assigns_tags` mints one `tag_assignment` per marker so the
   *  scheduler resolves each `tag_observed` to a `marker_traversed`. */
  seedIdentityTags(
    bus,
    scene.layout.markers.map((m) => m.id),
    newId,
    nowIso,
  );

  const world = new PhysicsWorld(scene.net);
  const markerById = new Map(scene.markers.map((m) => [m.id, m]));
  const trains: ScheduledTrainDevice[] = [];
  const teardown: Array<() => void> = [];

  return {
    world,
    server,
    client: bus,
    events,
    spawnTrain(trainId, options) {
      const atMarker = options?.atMarker ?? scene.layout.markers[0]?.id;
      const start = atMarker === undefined ? undefined : markerById.get(atMarker);
      world.addBody({
        id: trainId,
        kind: 'loco',
        segment: options?.segment ?? 'main',
        railPos: options?.railPos ?? start?.x ?? 0,
        facing: options?.facing ?? 1,
        maxSpeed: options?.maxSpeed ?? 400,
      });
      const device = new ScheduledTrainDevice(trainId, {
        platform: mqttPlatform(bus, trainId, { newId, now: nowIso }),
        motor: physicsMotorActuator(world, trainId),
        sensor: physicsMarkerSensor(
          world,
          trainId,
          [...scene.markers],
          undefined,
          scene.segmentLayer,
        ),
        layout: scene.layout,
        lengthMm: options?.lengthMm ?? 120,
        canReverse: options?.canReverse ?? true,
        newId,
        now: nowIso,
      });
      device.start();
      trains.push(device);
      teardown.push(() => device.stop());
      return device;
    },
    spawnGate(deviceId, options) {
      const device = new GateDevice(deviceId, {
        platform: mqttPlatform(bus, deviceId, { newId, now: nowIso }),
        markers: options.markers,
        ...(options.initialWithheld === undefined
          ? {}
          : { initialWithheld: options.initialWithheld }),
        newId,
        now: nowIso,
      });
      device.start();
      teardown.push(() => device.stop());
      return device;
    },
    spawnSwitch(deviceId, options) {
      const device = new SwitchDevice(deviceId, {
        platform: mqttPlatform(bus, deviceId, { newId, now: nowIso }),
        actuator: physicsSwitchActuator(world, options.switchLabel),
        junctionMarkerId: options.junctionMarkerId,
        positions: options.positions,
        newId,
        now: nowIso,
      });
      device.start();
      teardown.push(() => device.stop());
      return device;
    },
    assignSchedule(trainId, stops, routeId) {
      server.assignSchedule(trainId, routeId ?? `route-${trainId}-${clockMs}`, [...stops]);
    },
    advance(ms) {
      const ticks = Math.max(1, Math.round(ms / (DT * 1000)));
      for (let i = 0; i < ticks; i++) {
        world.step(DT);
        for (const train of trains) train.step(DT);
        clockMs += DT * 1000;
      }
    },
    commandsFor(deviceId) {
      return commands.filter((c) => c.device_id === deviceId);
    },
    eventsOfType(eventType) {
      return events.filter((e) => e.event_type === eventType);
    },
    shutdown() {
      for (const off of teardown) off();
      server.stop();
    },
  };
}

function seedIdentityTags(
  bus: InMemoryBrokerClient,
  markerIds: readonly string[],
  newId: () => string,
  now: () => string,
): void {
  const garage = mqttPlatform(bus, 'GARAGE', { newId, now });
  garage.register({
    manifest_version: '1.0',
    vendor: 'trainframe.sim',
    device_kind: 'tag-garage',
    version: '0.1.0',
    protocol_version: PROTOCOL_VERSION,
    display_name: 'Tag garage',
    description: 'Mints identity tag assignments for the test layout.',
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

interface WireEnvelope {
  readonly device_id?: unknown;
  readonly command_type?: unknown;
  readonly payload?: unknown;
}

function decodeJson(payload: Uint8Array): WireEnvelope | null {
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (raw === null || typeof raw !== 'object') return null;
    return raw as WireEnvelope;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
