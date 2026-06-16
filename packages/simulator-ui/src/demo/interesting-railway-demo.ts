/**
 * The INTERESTING-RAILWAY demo composition root — the 4-train scheduled stress test
 * (milestone 2). It assembles the interesting layout into ONE running thing driven by
 * the REAL `@trainframe/server` scheduler, exactly like `branching-demo.ts`:
 *
 *   - `buildMainLoopScene` + `interestingToLayout` (the winding loop + flyover + the
 *     drive-through parallelogram yard, projected to the logical marker graph),
 *   - ONE `PhysicsWorld` over the scene's switched `RailNetwork`,
 *   - a `ScheduledTrainDevice` per loco (FOUR — each with a distinct station rota) and
 *     a `SwitchDevice` for each running-line junction (the two satellites + the yard
 *     divert),
 *
 * all talking to core through a `PlatformProvider` the caller supplies per device id
 * (`mqttPlatform` on a broker). The composition root NEVER assigns routes or drives
 * logic — it wires the devices and exposes `step(dtS)`; route assignment is the
 * operator's job (`server.assignSchedule`).
 *
 * Unlike the branching demo (THREE trains — its only path threaded an IN-LINE yard, so
 * a fourth circular-waited), this layout's yard is a DRIVE-THROUGH detour with a
 * bypass: trains circulate the main loop freely and only divert into the yard on a
 * rota, so four trains never gridlock the running line.
 *
 * Pure wiring: no Date.now / Math.random. DOM-free — safe from a Node test runner.
 */
import type { Layout } from '@trainframe/protocol';
import type { MarkerPoint } from '../devices/marker-sensor.js';
import type { PlatformProvider } from '../devices/platform-provider.js';
import { ScheduledTrainDevice } from '../devices/scheduled-train-device.js';
import { SwitchDevice } from '../devices/switch-device.js';
import { YardZoneDevice } from '../devices/yard-zone-device.js';
import { type MainLoopScene, buildMainLoopScene } from '../physics/interesting-layout.js';
import {
  INTERESTING_MARKERS as M,
  buildInterestingMarkers,
  interestingToLayout,
} from '../physics/interesting-markers.js';
import type { SceneMarker } from '../physics/markers.js';
import { parallelogramYardLayout } from '../physics/parallelogram-yard-layout.js';
import { PhysicsWorld } from '../physics/world.js';
import { ladderSwitchActuator } from '../sim/ladder-switch-actuator.js';
import { physicsMarkerSensor } from '../sim/marker-sensor.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { physicsSwitchActuator } from '../sim/switch-actuator.js';

export type PlatformFactory = (deviceId: string) => PlatformProvider;

/** A train's cyclic route + livery + home (the marker its body seeds on, which must be
 *  `route.stops[0]` so the device's route belief and the body agree from tick one). */
interface TrainPlacement {
  readonly id: string;
  readonly routeId: string;
  readonly stops: readonly string[];
  readonly color: string;
  readonly cars: number;
}

/** FOUR trains, each homed at a DISTINCT marker, SPACED so no body seeds boxed into a
 *  single-edge block (the bottom-left markers south/west/north are only one edge apart,
 *  so crowding trains there gives the scheduler a tight seed-time waits-for cycle it
 *  cannot unwind). Three circulate the main loop two-to-three edges apart; the fourth
 *  seeds OFF the main on the satA loop, so the running line carries three trains evenly
 *  and the satellite exercises a divert. Each has a distinct station rota (so they don't
 *  all chase the same calls). All declare `can_reverse` (eligible for a yard service).
 *  Routes are cycles, beginning at home, every leg forward along the directed loop. */
const TRAINS: readonly TrainPlacement[] = [
  { id: 'T1', routeId: 'r1', stops: [M.north, M.east, M.south], color: '#c0392b', cars: 2 },
  { id: 'T2', routeId: 'r2', stops: [M.satAStation, M.south, M.north], color: '#2e6fb7', cars: 2 },
  { id: 'T3', routeId: 'r3', stops: [M.east, M.north, M.south], color: '#27ae60', cars: 2 },
  { id: 'T4', routeId: 'r4', stops: [M.south, M.west, M.north], color: '#e08a1e', cars: 2 },
];

/** The yard zone device id (gates_zone at the yard throat). */
export const INTERESTING_YARD_DEVICE_ID = 'YARD-INTERESTING';
/** The yard's service capacity — the gate admits up to this many visitors (queued, one
 *  serviced at a time) before denying. One slot always holds the (rotating) spares, so
 *  it is one fewer than the slot count; below it, circulating trains pass the throat
 *  freely (the detour's bypass is never gated). */
const YARD_CAPACITY = 4;
/** Which slot the INITIAL spares cut is stabled in (an inner road). From here it
 *  rotates — each visitor's shed cut becomes the next visitor's spares. */
const SPARES_SLOT_INDEX = 1;
/** The throat camera only counts a STOPPED loco as an arrival to service, so a train
 *  merely passing the throat on the bypass is never grabbed (mm/s). */
const PARKED_SPEED_EPS = 4;

export interface InterestingRailwayDemo {
  readonly scene: MainLoopScene;
  readonly layout: Layout;
  readonly world: PhysicsWorld;
  readonly trainIds: readonly string[];
  readonly switchDeviceIds: readonly string[];
  readonly yardDeviceId: string;
  /** train id → its cyclic route (for the operator to `assignSchedule`). */
  readonly routes: ReadonlyMap<string, { routeId: string; stops: readonly string[] }>;
  start(): void;
  stop(): void;
  step(dtS: number): void;
}

/** Project a marker to its world point (where a loco's tag reader meets it). */
function markerPoints(scene: MainLoopScene, markers: readonly SceneMarker[]): MarkerPoint[] {
  return markers.map((m) => {
    const rail = scene.net.railOf(m.segment);
    const d = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
    const p = rail.at(d);
    return { id: m.id, x: p.x, y: p.y };
  });
}

/** Where a marker sits along its segment — a body seeds here, a touch inside the
 *  segment so it isn't sitting on a node. */
function markerRailPos(
  scene: MainLoopScene,
  markers: readonly SceneMarker[],
  markerId: string,
): { segment: string; railPos: number } {
  const m = markers.find((mk) => mk.id === markerId);
  if (m === undefined) throw new Error(`interesting-demo: no marker ${markerId}`);
  const rail = scene.net.railOf(m.segment);
  const railPos = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
  return { segment: m.segment, railPos: Math.max(20, Math.min(rail.length - 20, railPos)) };
}

/** Seed a loco + its trailing cut at its home stop, facing forward. */
function seedTrain(
  world: PhysicsWorld,
  scene: MainLoopScene,
  markers: readonly SceneMarker[],
  t: TrainPlacement,
): void {
  const { segment, railPos } = markerRailPos(scene, markers, t.stops[0] ?? M.north);
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

/** Seed the spares cut (two carriages, coupled) stabled in the yard's spares slot, so
 *  the swap controller has a rake to migrate onto the visiting loco. */
function seedSpares(world: PhysicsWorld, scene: MainLoopScene, sparesSlot: string): void {
  const len = scene.net.railOf(sparesSlot).length;
  world.addBody({
    id: 'spare0',
    kind: 'carriage',
    segment: sparesSlot,
    railPos: len * 0.55,
    facing: 1,
    color: '#7d3cab',
  });
  world.addBody({
    id: 'spare1',
    kind: 'carriage',
    segment: sparesSlot,
    railPos: len * 0.55 - 68,
    facing: 1,
    color: '#7d3cab',
  });
  world.couple('spare0', 'spare1');
}

/** The nearest STOPPED loco within `r` of (x,y), or null. The throat camera uses this so
 *  a train merely passing the throat on the bypass (still moving) is never mistaken for a
 *  visitor parked there awaiting service. */
function nearestStoppedLoco(world: PhysicsWorld, x: number, y: number, r: number): string | null {
  let best: { id: string; d2: number } | null = null;
  for (const b of world.bodies()) {
    if (b.kind !== 'loco' || b.speed > PARKED_SPEED_EPS) continue;
    const d2 = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (best === null || d2 < best.d2) best = { id: b.id, d2 };
  }
  return best === null || best.d2 > r * r ? null : best.id;
}

/** Build the 4-train interesting-railway demo. `platformFactory` binds each device id
 *  to its transport (the same assembly runs over MQTT in a harness or the browser). */
export function buildInterestingRailwayDemo(
  platformFactory: PlatformFactory,
): InterestingRailwayDemo {
  const scene = buildMainLoopScene();
  const ml = buildInterestingMarkers(scene);
  const layout = interestingToLayout(scene);
  const world = new PhysicsWorld(scene.net);
  const points = markerPoints(scene, ml.markers);

  for (const t of TRAINS) seedTrain(world, scene, ml.markers, t);

  const trains = TRAINS.map(
    (t) =>
      new ScheduledTrainDevice(t.id, {
        platform: platformFactory(t.id),
        motor: physicsMotorActuator(world, t.id),
        sensor: physicsMarkerSensor(world, t.id, points),
        layout,
        lengthMm: 60 + t.cars * 68,
        canReverse: true,
      }),
  );

  /* One SwitchDevice per running-line junction (the two satellite diverts + the yard
   *  divert) — the scheduler throws these to route a train onto a satellite loop or
   *  into the yard detour. */
  const switches = ml.junctions.map(
    (j) =>
      new SwitchDevice(`SWITCH-${j.markerId}`, {
        platform: platformFactory(`SWITCH-${j.markerId}`),
        actuator: physicsSwitchActuator(world, j.switchId),
        junctionMarkerId: j.markerId,
        positions: j.positions,
      }),
  );

  /* The YARD as a `core.gates_zone` device — the SAME zone device + `YardController`
   *  swap the branching demo uses, over the parallelogram drive-through yard. The
   *  visitor stops at the yard throat (a scheduled stop); the zone diverts it off the
   *  running line, swaps its rear cut for the stabled spares (crane decouples only —
   *  on-rail throughout), and releases it back onto the line past the merge. */
  const yardSeg = scene.yard;
  const sparesSlot = yardSeg.slots[SPARES_SLOT_INDEX];
  if (sparesSlot === undefined) {
    throw new Error('interesting-demo: yard needs at least 2 slots');
  }
  seedSpares(world, scene, sparesSlot);
  const YARD_CAM_R = 20;
  /* The throat sits at the yard's own approach lead (`leadWest`/`topLeadIn`), where the
   *  marker M.yard rides — so the zone's default throat camera (leadWest start) already
   *  points at it, and only a train switched into the yard ever parks there. */
  const yard = new YardZoneDevice(INTERESTING_YARD_DEVICE_ID, {
    platform: platformFactory(INTERESTING_YARD_DEVICE_ID),
    scene: {
      yard: parallelogramYardLayout(scene.net, scene.geom, yardSeg),
      throatMarker: M.yard,
      sparesSlot,
    },
    capacity: YARD_CAPACITY,
    westPoints: ladderSwitchActuator(world, yardSeg, 'top'),
    eastPoints: ladderSwitchActuator(world, yardSeg, 'bottom'),
    look: (x, y) => {
      const s = world.sampleAt(x, y, YARD_CAM_R);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
    wedgeAt: (x, y) => {
      world.uncoupleAt(x, y);
    },
    sightedTrainAt: (x, y, r) => nearestStoppedLoco(world, x, y, r),
    motorFor: (id) => physicsMotorActuator(world, id),
  });

  let started = false;
  return {
    scene,
    layout,
    world,
    trainIds: TRAINS.map((t) => t.id),
    switchDeviceIds: switches.map((s) => s.deviceId),
    yardDeviceId: INTERESTING_YARD_DEVICE_ID,
    routes: new Map(TRAINS.map((t) => [t.id, { routeId: t.routeId, stops: t.stops }])),
    start(): void {
      if (started) return;
      started = true;
      yard.start();
      for (const sw of switches) sw.start();
      for (const train of trains) train.start();
    },
    stop(): void {
      started = false;
      for (const train of trains) train.stop();
      for (const sw of switches) sw.stop();
      yard.stop();
    },
    step(dtS: number): void {
      world.step(dtS);
      yard.step(dtS);
      for (const train of trains) train.step(dtS);
    },
  };
}
