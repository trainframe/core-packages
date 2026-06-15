/**
 * The BRANCHING DEMO composition root (FROZEN SPEC §5). It assembles the parallel
 * modules into ONE running thing driven by the REAL `@trainframe/server`
 * scheduler:
 *
 *   - Engineer A's `buildBranchingScene` / `sceneToLayout` (the marker layer),
 *   - ONE `PhysicsWorld` over the scene's switched `RailNetwork`,
 *   - Engineer B's `ScheduledTrainDevice` per loco + a `SwitchDevice` for the
 *     `Jspur` main-line junction,
 *   - Engineer C's `YardZoneDevice` for the opaque IN-LINE yard zone,
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

/** The yard zone's device id, exported so the render script can wait for it to
 *  register (the browser owns the device; the script only assigns + watches). */
export const YARD_DEVICE_ID = 'YARD-1';
/** The spur junction switch device id, exported for the same reason. */
export const SPUR_SWITCH_ID = 'SWITCH-spur';

/** Two carriages behind a yard-visiting loco, for the train→train migration. */
const VISITOR_CARS = 2;

/**
 * The three trains of the deadlock-free spectacle (FROZEN SPEC §8, reworked).
 * Each starts parked just inside the segment that carries its first stop's marker
 * so its first `train_status` seeds a real heading before the operator assigns its
 * cyclic route. All declare `can_reverse` (any may be admitted to the yard).
 *
 * Why THREE, not four: the running ring is a single cycle threading the in-line
 * yard, and the scheduler does no deadlock avoidance (an open design question).
 * Four trains all circulating a ring whose only yard is a slow capacity-1 zone
 * form a circular wait — a fourth train (a pure branch loop that must return to
 * the spur THROUGH the yard) ties up the branch, the main ring AND the yard at
 * once and gridlocks. Three trains — the express, the yard turn, and the branch
 * reliever — keep at least one block clear in the cycle at all times, so the run
 * is deadlock-free BY CONSTRUCTION (proven headless in `branching-liveness.test`).
 * It still shows multiple trains on distinct routes, the scenic BRANCH (T4), and
 * MULTIPLE trains queueing at the yard (all three visit it, capacity 1).
 *
 * Each homes at a DISTINCT marker so the three bodies seed clear of one another:
 * T1 (express) on the right ascending straight (`M-main-e`), clear of the left
 * descent; T2 (yard turn) at `M-top`, descending the left straight toward the yard
 * (held a block back by section exclusivity, never rammed); T4 (branch reliever)
 * on the branch return (`M-branch-bot`), off the main ring. Routes are cycles,
 * rotated to begin at the home stop.
 */
const TRAINS: readonly TrainPlacement[] = [
  {
    id: 'T1',
    /* The express circulates the main loop. Homed on the right ascending straight
     *  (`M-main-e`) so a parked T1 sits clear of the left-straight descent the
     *  yard-turn trains use — no seed-collision. Its loop crosses the IN-LINE yard,
     *  so the yard throat is a scheduled stop (ADR-028 cyclic resume): a train
     *  whose path enters the zone MUST schedule it as a stop, or the zone releases
     *  it with nowhere to go. Serviced each lap (a wagon migrates). Cycle (rotated
     *  to its home): M-main-e → M-top → M-central → the in-line yard → back. */
    route: {
      routeId: 'rA-express',
      stops: ['M-main-e', 'M-top', 'M-central', 'M-yard-throat'],
      canReverse: true,
    },
    color: '#c0392b',
    homeStop: 'M-main-e',
    cars: VISITOR_CARS,
  },
  {
    id: 'T2',
    route: {
      routeId: 'rB-yardturn',
      stops: ['M-top', 'M-yard-throat', 'M-spur'],
      canReverse: true,
    },
    color: '#2e6fb7',
    homeStop: 'M-top',
    cars: VISITOR_CARS,
  },
  {
    id: 'T4',
    /* The branch reliever, homed on the BRANCH return (`M-branch-bot`, OFF the
     *  main ring) so it seeds clear of the express + the yard-turn. Its cycle runs
     *  the branch up to `M-top`, then descends the main loop into the IN-LINE yard
     *  (a scheduled stop), converging on the throat behind T2 (the queueing proof)
     *  before looping back up the branch. Exercises the distinct BRANCH AND the
     *  yard queue in one train. */
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

/** The per-train route plan (train id → its cyclic route), exported so an operator
 *  (the render script) can `assignSchedule` each train WITHOUT building a world or
 *  its devices — the browser owns those. Derived from the single `TRAINS` source so
 *  it can never drift from what the devices believe their routes are. */
export const DEMO_ROUTES: ReadonlyMap<string, DemoRoute> = new Map(
  TRAINS.map((t) => [t.id, t.route]),
);

/** The sim-side throat camera: the id of the loco whose pose lies within `r` of
 *  (x,y), or null. This binds the yard device's `sightedTrainAt` provider to the
 *  world HERE (the composition root), so the device reads only a sighted tag id. */
function nearestLocoId(world: PhysicsWorld, x: number, y: number, r: number): string | null {
  let best: { id: string; d2: number } | null = null;
  for (const b of world.bodies()) {
    if (b.kind !== 'loco') continue;
    const d2 = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (best === null || d2 < best.d2) best = { id: b.id, d2 };
  }
  return best === null || best.d2 > r * r ? null : best.id;
}

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

  /* Bind the yard device's providers to the sim HERE (the composition root is the
   *  sim-wiring layer — world access is legitimate). The device itself never sees
   *  the world: it perceives through `look`/`sightedTrainAt` and acts through the
   *  points/wedge/motor providers. */
  const YARD_CAM_R = 20;
  const yard = new YardZoneDevice(YARD_DEVICE_ID, {
    platform: platformFactory(YARD_DEVICE_ID),
    scene,
    capacity: YARD_CAPACITY,
    westPoints: physicsSwitchActuator(world, scene.yard.westSwitch),
    eastPoints: physicsSwitchActuator(world, scene.yard.eastSwitch),
    look: (x, y) => {
      const s = world.sampleAt(x, y, YARD_CAM_R);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
    wedgeAt: (x, y) => {
      world.uncoupleAt(x, y);
    },
    sightedTrainAt: (x, y, r) => nearestLocoId(world, x, y, r),
    motorFor: (id) => physicsMotorActuator(world, id),
  });

  const routes = DEMO_ROUTES;

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
