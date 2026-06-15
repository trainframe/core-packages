/**
 * Builds the running WORLD for the "interesting" layout demo (ADR-030) — the sim
 * wiring behind `InterestingLayoutView`, kept out of the React component so it can be
 * driven headless by a guardrail test (the same setup the user sees, asserted without
 * a browser). It seeds a LAPPING train (loco + two carriages) driving the main loop,
 * diverted through both satellites including the crossover flyover — so the demo MOVES
 * and rides over the bridge — and a rake STABLED in the bottom-left yard.
 *
 * (The carriage-SWAP service is being rebuilt as an on-rail shunting move — the
 * visiting train's own loco drops its rear cut and collects the spares, the crane only
 * decoupling — so it is not wired here yet; this builder is just the running scene.)
 */
import type { buildMainLoopScene } from '../physics/interesting-layout.js';
import { PhysicsWorld } from '../physics/world.js';

type Scene = ReturnType<typeof buildMainLoopScene>;

export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface InterestingDemo {
  readonly world: PhysicsWorld;
  /** The yard siding-fan bounds (for framing). */
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

/** Stable a rake (loco + two carriages) in the first yard siding, so the yard reads
 *  as in use. Static — no service drives it yet. */
function stableYardStock(world: PhysicsWorld, scene: Scene): void {
  const road = scene.yard.sidings[0];
  if (road === undefined) return;
  const locoPos = scene.net.railOf(road).length - 120;
  world.addBody({
    id: 'YT',
    kind: 'loco',
    railPos: locoPos,
    facing: 1,
    segment: road,
    color: '#2d6cdf',
  });
  for (let i = 0; i < 2; i++) {
    const id = `YT-c${i}`;
    world.addBody({
      id,
      kind: 'carriage',
      railPos: locoPos - (i + 1) * 68,
      facing: 1,
      segment: road,
      color: '#8e44ad',
    });
    world.couple(i === 0 ? 'YT' : `YT-c${i - 1}`, id);
  }
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

  stableYardStock(world, scene);
  return { world, yardRect: yardBounds(scene) };
}
