/**
 * The BRANCHING DEMO composition root (FROZEN SPEC §5). It assembles the parallel
 * modules into ONE running thing driven by the REAL `@trainframe/server`
 * scheduler:
 *
 *   - Engineer A's `buildBranchingScene` / `sceneToLayout` (the marker layer),
 *   - ONE `PhysicsWorld` over the scene's switched `RailNetwork`,
 *   - Engineer B's `ScheduledTrainDevice` per loco + a `SwitchDevice` for the
 *     `Jspur` main-line junction,
 *   - Engineer C's `YardZoneDevice` for the opaque yard (it owns the `Jloop` tap),
 *
 * all talking to core through a `PlatformProvider`. The caller supplies a
 * `platformFactory(deviceId)` so the SAME assembly runs:
 *   - over `mqttPlatform` on the harness broker (the headless gate + the render
 *     script — devices in Node), and
 *   - over `mqttPlatform` on the browser's broker client (the rendered demo).
 *
 * The composition root NEVER assigns routes or drives logic — it only wires the
 * devices and exposes `step(dtS)` (world + zone + every train). Route assignment
 * is the operator's job (`harness.server.assignSchedule`), per §8. Pure: no
 * Date.now / Math.random in the wiring (envelope ids/timestamps are the platform's
 * concern). DOM-free — safe to import from a Node test runner.
 */
import type { Layout } from '@trainframe/protocol';
import type { MarkerPoint } from '../devices/marker-sensor.js';
import { physicsMarkerSensor } from '../devices/marker-sensor.js';
import { physicsMotorActuator } from '../devices/motor-actuator.js';
import type { PlatformProvider } from '../devices/platform-provider.js';
import { ScheduledTrainDevice } from '../devices/scheduled-train-device.js';
import { physicsSwitchActuator } from '../devices/switch-actuator.js';
import { SwitchDevice } from '../devices/switch-device.js';
import { YardZoneDevice } from '../devices/yard-zone-device.js';
import { type BranchingScene, buildBranchingScene } from '../physics/branching-scene.js';
import { sceneToLayout } from '../physics/scene-markers.js';
import { PhysicsWorld } from '../physics/world.js';

/** A factory the caller wires to its transport: `mqttPlatform(client, id)` in the
 *  gate/script/browser, or `inProcessPlatform(bus, id)` in a focused test. */
export type PlatformFactory = (deviceId: string) => PlatformProvider;

/** A train's cyclic route plan (FROZEN SPEC §8). `stops` are marker ids the
 *  scheduler plans edges between and loops; `canReverse` lets it enter the yard. */
export interface DemoRoute {
  readonly routeId: string;
  readonly stops: readonly string[];
  readonly canReverse: boolean;
}

/** One loco's livery + its HOME stop (the marker its body is seeded on, and the
 *  marker its cyclic route starts at — so the body and the device's route belief
 *  agree from the first tick). */
interface TrainPlacement {
  readonly id: string;
  readonly route: DemoRoute;
  readonly color: string;
  /** The marker the body sits on at stage time — must equal `route.stops[0]`, so
   *  the train's first sensed crossing matches the route's first edge start. */
  readonly homeStop: string;
  readonly cars: number;
}

export interface BranchingDemo {
  readonly scene: BranchingScene;
  readonly layout: Layout;
  readonly world: PhysicsWorld;
  readonly trainIds: readonly string[];
  readonly yardDeviceId: string;
  readonly switchDeviceIds: readonly string[];
  /** Per-train route plan keyed by train id (for the operator to assign). */
  readonly routes: ReadonlyMap<string, DemoRoute>;
  /** Advance the whole demo one tick: world physics, then the zone's interior
   *  service, then every train's motion intent (the order the device contracts
   *  expect — world truth first, then the devices dead-reckon off it). */
  step(dtS: number): void;
  /** Start every device (register + subscribe). Idempotent per device. */
  start(): void;
  /** Stop every device. */
  stop(): void;
}

/** The yard slots one fewer than its physical slot count, reserving the spares
 *  slot — so a single visitor is admitted at a time while the queue proof (§6c)
 *  with `capacity:1` still holds for the demo's staggered yard calls. */
const SLOT_COUNT = 3;
const YARD_CAPACITY = 1;

const YARD_DEVICE_ID = 'YARD-1';
const SPUR_SWITCH_ID = 'SWITCH-spur';

/** Two carriages behind a yard-visiting loco, for the train→train migration. */
const VISITOR_CARS = 2;

/**
 * The four trains (FROZEN SPEC §8). Each starts parked just inside the segment
 * that carries its first stop's marker so its first `train_status` seeds a real
 * heading before the operator assigns its cyclic route. All declare `can_reverse`
 * (any may be admitted to the yard).
 */
/*
 * Each train homes at a DISTINCT marker (so the four bodies seed clear of one
 * another) chosen so the train's first move exercises what it is meant to: T2
 * homes at M-top so its first edge is the yard tap (M-main-w→M-yard-throat); T3
 * homes at the spur so its first edge is the branch diverge; T1 (express) and T4
 * (reliever) home on the bottom run, well clear. Routes are cycles, so each
 * stop-list is simply rotated to begin at the home stop.
 */
const TRAINS: readonly TrainPlacement[] = [
  {
    id: 'T1',
    route: {
      routeId: 'rA-express',
      stops: ['M-central', 'M-main-e', 'M-top', 'M-central'],
      canReverse: true,
    },
    color: '#c0392b',
    homeStop: 'M-central',
    cars: 0,
  },
  {
    id: 'T2',
    route: { routeId: 'rB-yardturn', stops: ['M-top', 'M-yard-throat', 'M-top'], canReverse: true },
    color: '#2e6fb7',
    homeStop: 'M-top',
    cars: VISITOR_CARS,
  },
  {
    id: 'T3',
    /* Homed AT the spur diverge so its FIRST move takes the branch — the spur
     *  switch is thrown to `branch` straight away, and it vacates the right
     *  straight for the express behind it. */
    route: {
      routeId: 'rC-branch',
      stops: ['M-spur', 'M-branch-top', 'M-branch-bot', 'M-top', 'M-spur'],
      canReverse: true,
    },
    color: '#27a35a',
    homeStop: 'M-spur',
    cars: 0,
  },
  {
    id: 'T4',
    /* Homed on the BRANCH return (OFF the main loop), so it never fouls the
     *  express or the express's right straight; its yard route rejoins at M-top
     *  then takes the tap — converging on the throat with T2 (the queueing proof)
     *  without crossing a parked train. */
    route: {
      routeId: 'rD-reliever',
      stops: ['M-branch-bot', 'M-top', 'M-yard-throat', 'M-branch-bot'],
      canReverse: true,
    },
    color: '#e08a1e',
    homeStop: 'M-branch-bot',
    cars: VISITOR_CARS,
  },
];

/** Project every scene marker to its world point (where the loco's tag reader
 *  physically meets it) — the sensor input the device needs but does not own. */
function markerPoints(scene: BranchingScene): MarkerPoint[] {
  return scene.markers.map((m) => {
    const rail = scene.net.railOf(m.segment);
    const d = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
    const p = rail.at(d);
    return { id: m.id, x: p.x, y: p.y };
  });
}

/** Where a marker sits along its anchor segment (distance from the segment start,
 *  mm) — the body is seeded here so its first sensed crossing is its home stop. */
function markerRailPos(
  scene: BranchingScene,
  markerId: string,
): { segment: string; railPos: number } {
  const m = scene.markers.find((mk) => mk.id === markerId);
  if (m === undefined) throw new Error(`branching-demo: no marker ${markerId}`);
  const rail = scene.net.railOf(m.segment);
  const railPos = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
  /* Seed a touch INSIDE the segment so a body anchored at a segment end is not
   *  sitting exactly on a node (where the next-segment transition lives). */
  const clamped = Math.max(20, Math.min(rail.length - 20, railPos));
  return { segment: m.segment, railPos: clamped };
}

/** Seed a loco body (+ its rear cut, trailing behind it) onto the network at its
 *  home stop, facing forward (+rail). */
function seedTrainBody(world: PhysicsWorld, scene: BranchingScene, t: TrainPlacement): void {
  const { segment, railPos } = markerRailPos(scene, t.homeStop);
  world.addBody({ id: t.id, kind: 'loco', segment, railPos, facing: 1, color: t.color });
  for (let i = 0; i < t.cars; i++) {
    const cid = `${t.id}-c${i}`;
    const prev = i === 0 ? t.id : `${t.id}-c${i - 1}`;
    world.addBody({
      id: cid,
      kind: 'carriage',
      segment,
      railPos: Math.max(2, railPos - (i + 1) * 68),
      facing: 1,
      color: t.color,
    });
    world.couple(prev, cid);
  }
}

/** Seed the yard's spares cut (two carriages, coupled) in the spares slot so the
 *  interior `YardController` has a cut to migrate a visitor's wagons onto. */
function seedSpares(world: PhysicsWorld, scene: BranchingScene): void {
  const slot = scene.sparesSlot;
  world.addBody({
    id: 'spare0',
    kind: 'carriage',
    segment: slot,
    railPos: 200,
    facing: 1,
    color: '#9b59b6',
  });
  world.addBody({
    id: 'spare1',
    kind: 'carriage',
    segment: slot,
    railPos: 132,
    facing: 1,
    color: '#9b59b6',
  });
  world.couple('spare0', 'spare1');
}

/**
 * Build the branching demo. The caller supplies a `platformFactory` binding each
 * device id to its transport. Geometry/topology is fixed (pure); only the device
 * transport varies between the gate, the render script, and the browser.
 */
export function buildBranchingDemo(platformFactory: PlatformFactory): BranchingDemo {
  const scene = buildBranchingScene(SLOT_COUNT);
  const layout = sceneToLayout(scene, 'branching');
  const world = new PhysicsWorld(scene.net);
  const points = markerPoints(scene);

  for (const t of TRAINS) seedTrainBody(world, scene, t);
  seedSpares(world, scene);

  const trains = TRAINS.map((t) => {
    const device = new ScheduledTrainDevice(t.id, {
      platform: platformFactory(t.id),
      motor: physicsMotorActuator(world, t.id),
      sensor: physicsMarkerSensor(world, t.id, points),
      layout,
      lengthMm: 60 + t.cars * 68,
      canReverse: t.route.canReverse,
    });
    return device;
  });

  const spur = new SwitchDevice(SPUR_SWITCH_ID, {
    platform: platformFactory(SPUR_SWITCH_ID),
    actuator: physicsSwitchActuator(world, 'Jspur'),
    junctionMarkerId: 'M-spur',
    positions: ['thru', 'branch'],
  });

  const yard = new YardZoneDevice(YARD_DEVICE_ID, {
    platform: platformFactory(YARD_DEVICE_ID),
    world,
    scene,
    capacity: YARD_CAPACITY,
    yardTap: physicsSwitchActuator(world, 'Jloop'),
  });

  const routes = new Map<string, DemoRoute>(TRAINS.map((t) => [t.id, t.route]));

  let started = false;
  return {
    scene,
    layout,
    world,
    trainIds: TRAINS.map((t) => t.id),
    yardDeviceId: YARD_DEVICE_ID,
    switchDeviceIds: [SPUR_SWITCH_ID],
    routes,
    start(): void {
      if (started) return;
      started = true;
      yard.start();
      spur.start();
      for (const train of trains) train.start();
    },
    stop(): void {
      started = false;
      for (const train of trains) train.stop();
      spur.stop();
      yard.stop();
    },
    step(dtS: number): void {
      world.step(dtS);
      yard.step(dtS);
      for (const train of trains) train.step(dtS);
    },
  };
}
