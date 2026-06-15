/**
 * Builds the running WORLD for the "interesting" layout demo (ADR-030) — the sim
 * wiring behind `InterestingLayoutView`, kept out of the React component so it can be
 * driven headless by a guardrail test (the same setup the user sees, asserted without
 * a browser). It seeds:
 *
 *   - a LAPPING train (loco + two carriages) driving the main loop, diverted through
 *     both satellites including the crossover flyover — so the demo MOVES and rides
 *     over the bridge;
 *   - a PARKED train + spare cut in the bottom-left yard, with a looping crane-swap
 *     service that lifts the train's rear carriages off and sets the spares on.
 *
 * The crane is a real device driven by `CraneSwapController` through injected
 * lift/place ops — it moves because it has a job, never on a timer. Returns the world,
 * the crane + controller (to step), and the yard rect (for the view's gantry).
 */
import { CraneSwapController } from '../devices/crane-swap-controller.js';
import { Crane } from '../devices/crane.js';
import type { buildMainLoopScene } from '../physics/interesting-layout.js';
import { PhysicsWorld } from '../physics/world.js';
import { craneSwapOps } from './crane-swap-ops.js';

type Scene = ReturnType<typeof buildMainLoopScene>;

export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface InterestingDemo {
  readonly world: PhysicsWorld;
  /** The yard crane + its controller — undefined if the yard has too few sidings. */
  readonly crane: Crane | undefined;
  readonly ctrl: CraneSwapController | undefined;
  /** The yard siding-fan bounds (for drawing the gantry). */
  readonly yardRect: Rect;
}

/** The bottom-left siding-fan bounds, by sampling the siding rails. */
function yardBounds(scene: Scene): Rect {
  const pts = scene.yard.sidings.flatMap((id) => {
    const r = scene.net.railOf(id);
    const out: { x: number; y: number }[] = [];
    const n = Math.max(2, Math.ceil(r.length / 30));
    for (let i = 0; i <= n; i++) out.push(r.at((r.length * i) / n));
    return out;
  });
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** Seed a parked train + spare cut and wire a looping crane-swap service over them. */
function wireYardCrane(
  w: PhysicsWorld,
  scene: Scene,
  yardRect: Rect,
): { ctrl: CraneSwapController; crane: Crane } | undefined {
  const trainRoad = scene.yard.sidings[0];
  const sparesRoad = scene.yard.sidings[1];
  const holdingRoad = scene.yard.sidings[2];
  if (trainRoad === undefined || sparesRoad === undefined || holdingRoad === undefined) return;

  const locoPos = scene.net.railOf(trainRoad).length - 120;
  w.addBody({
    id: 'YT',
    kind: 'loco',
    railPos: locoPos,
    facing: 1,
    segment: trainRoad,
    color: '#2d6cdf',
  });
  for (let i = 0; i < 2; i++) {
    const id = `YT-c${i}`;
    w.addBody({
      id,
      kind: 'carriage',
      railPos: locoPos - (i + 1) * 68,
      facing: 1,
      segment: trainRoad,
      color: '#8e44ad',
    });
    w.couple(i === 0 ? 'YT' : `YT-c${i - 1}`, id);
  }
  const sparesLen = scene.net.railOf(sparesRoad).length;
  w.addBody({
    id: 'SP0',
    kind: 'carriage',
    railPos: sparesLen - 120,
    facing: 1,
    segment: sparesRoad,
    color: '#27ae60',
  });
  w.addBody({
    id: 'SP1',
    kind: 'carriage',
    railPos: sparesLen - 188,
    facing: 1,
    segment: sparesRoad,
    color: '#27ae60',
  });
  w.couple('SP0', 'SP1');

  const poseOf = (id: string) => w.bodies().find((b) => b.id === id);
  const rear = poseOf('YT-c1');
  const couple = poseOf('YT-c0');
  const spare = poseOf('SP0');
  if (rear === undefined || couple === undefined || spare === undefined) return;
  const holdLen = scene.net.railOf(holdingRoad).length;
  const holdPt = scene.net.railOf(holdingRoad).at(holdLen - 154);

  const crane = new Crane(
    {
      minX: yardRect.minX - 60,
      maxX: yardRect.maxX + 60,
      minY: yardRect.minY - 60,
      maxY: yardRect.maxY + 60,
    },
    { x: rear.x, y: rear.y },
  );
  const ops = craneSwapOps(w);
  const ctrl = new CraneSwapController({
    crane,
    liftCut: ops.liftCut,
    placeCut: ops.placeCut,
    trainRear: { x: rear.x, y: rear.y },
    trainCouple: { x: couple.x, y: couple.y },
    spares: { x: spare.x, y: spare.y },
    holding: { x: holdPt.x, y: holdPt.y },
    loop: true,
  });
  return { ctrl, crane };
}

/** Build the demo world for `scene` (typically `buildMainLoopScene()`). */
export function buildInterestingDemo(scene: Scene): InterestingDemo {
  const world = new PhysicsWorld(scene.net);
  /* Running line stays over the yard, but the lapping train diverts through both
   *  satellites — including the crossover loop, so it rides over the flyover. */
  world.setSwitch(scene.branches.yard.switchId, scene.branches.yard.mainPos);
  world.setSwitch(scene.branches.satA.switchId, scene.branches.satA.loopPos);
  world.setSwitch(scene.branches.satB.switchId, scene.branches.satB.loopPos);

  world.addBody({
    id: 'T',
    kind: 'loco',
    railPos: 10,
    facing: 1,
    segment: scene.startSegment,
    color: '#c0392b',
    motion: 'forward',
    maxSpeed: 200,
  });
  for (let i = 0; i < 2; i++) {
    const id = `T-c${i}`;
    world.addBody({
      id,
      kind: 'carriage',
      railPos: 10 - (i + 1) * 68,
      facing: 1,
      segment: scene.startSegment,
      color: '#e08a1e',
    });
    world.couple(i === 0 ? 'T' : `T-c${i - 1}`, id);
  }

  const yardRect = yardBounds(scene);
  const yard = wireYardCrane(world, scene, yardRect);
  return { world, crane: yard?.crane, ctrl: yard?.ctrl, yardRect };
}
