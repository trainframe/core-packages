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
import { type MainLoopScene, buildMainLoopScene } from '../physics/interesting-layout.js';
import {
  INTERESTING_MARKERS as M,
  buildInterestingMarkers,
  interestingToLayout,
} from '../physics/interesting-markers.js';
import type { SceneMarker } from '../physics/markers.js';
import { PhysicsWorld } from '../physics/world.js';
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

/** FOUR trains, each homed at a DISTINCT station so the bodies seed clear, each with a
 *  different station rota (so they don't all chase the same calls). All declare
 *  `can_reverse` (eligible for a yard service). Routes are cycles, beginning at home. */
const TRAINS: readonly TrainPlacement[] = [
  { id: 'T1', routeId: 'r1', stops: [M.north, M.satAStation, M.south], color: '#c0392b', cars: 2 },
  { id: 'T2', routeId: 'r2', stops: [M.satBStation, M.north], color: '#2e6fb7', cars: 2 },
  { id: 'T3', routeId: 'r3', stops: [M.south, M.satBStation], color: '#27ae60', cars: 2 },
  { id: 'T4', routeId: 'r4', stops: [M.satAStation, M.south], color: '#e08a1e', cars: 2 },
];

export interface InterestingRailwayDemo {
  readonly scene: MainLoopScene;
  readonly layout: Layout;
  readonly world: PhysicsWorld;
  readonly trainIds: readonly string[];
  readonly switchDeviceIds: readonly string[];
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

  let started = false;
  return {
    scene,
    layout,
    world,
    trainIds: TRAINS.map((t) => t.id),
    switchDeviceIds: switches.map((s) => s.deviceId),
    routes: new Map(TRAINS.map((t) => [t.id, { routeId: t.routeId, stops: t.stops }])),
    start(): void {
      if (started) return;
      started = true;
      for (const sw of switches) sw.start();
      for (const train of trains) train.start();
    },
    stop(): void {
      started = false;
      for (const train of trains) train.stop();
      for (const sw of switches) sw.stop();
    },
    step(dtS: number): void {
      world.step(dtS);
      for (const train of trains) train.step(dtS);
    },
  };
}
