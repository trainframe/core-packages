import { describe, expect, it } from 'vitest';
import { buildMainLoopScene } from '../physics/interesting-layout.js';
import type { PhysicsWorld } from '../physics/world.js';
import { buildInterestingDemo } from './interesting-demo.js';

const STEP_S = 1 / 120;

/** Flood-fill `id`'s rake over couplings. */
function rake(world: PhysicsWorld, id: string): Set<string> {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    for (const n of world.coupledTo(cur))
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
  }
  return seen;
}

interface Observed {
  maxDist: number;
  rodeFlyover: boolean;
  spareReachedTrain: boolean; // a spare coupled onto the parked train
  parkedCarShed: boolean; // a parked car left the parked train's rake
  allRailed: boolean;
}

/** Drive the demo for `steps` and accumulate what the user would see. */
function observe(demo: ReturnType<typeof buildInterestingDemo>, steps: number): Observed {
  const { world, ctrl, crane } = demo;
  const startT = world.bodies().find((b) => b.id === 'T');
  if (startT === undefined) throw new Error('no lapping train');
  const startPt = { x: startT.x, y: startT.y };
  const o: Observed = {
    maxDist: 0,
    rodeFlyover: false,
    spareReachedTrain: false,
    parkedCarShed: false,
    allRailed: true,
  };
  for (let i = 0; i < steps; i++) {
    ctrl?.tick(STEP_S);
    crane?.step(STEP_S);
    world.step(STEP_S);
    const t = world.bodies().find((b) => b.id === 'T');
    if (t !== undefined) {
      o.maxDist = Math.max(o.maxDist, Math.hypot(t.x - startPt.x, t.y - startPt.y));
      if (t.segment === 'satB-loop') o.rodeFlyover = true;
    }
    const yt = rake(world, 'YT');
    if (yt.has('SP0') || yt.has('SP1')) o.spareReachedTrain = true;
    if (!yt.has('YT-c0') || !yt.has('YT-c1')) o.parkedCarShed = true;
  }
  o.allRailed = world.bodies().every((b) => b.mode === 'railed');
  return o;
}

describe('interesting-demo — the running world behind the view', () => {
  it('the lapping train MOVES, rides the flyover, and the yard crane actually swaps the rake', () => {
    const demo = buildInterestingDemo(buildMainLoopScene());
    expect(demo.ctrl).toBeDefined(); // the yard wired a crane service
    expect(demo.crane).toBeDefined();

    const o = observe(demo, 120 * 180);

    /* Movement: the train genuinely circulated (not the zero-movement bug). */
    expect(o.maxDist).toBeGreaterThan(600);
    /* It diverted over the self-crossing flyover. */
    expect(o.rodeFlyover).toBe(true);
    /* The crane really worked: a spare migrated onto the parked train, and the
     *  train's own cars were shed (not a decorative crane doing nothing). */
    expect(o.spareReachedTrain).toBe(true);
    expect(o.parkedCarShed).toBe(true);
    /* Nothing fell off the rails. */
    expect(o.allRailed).toBe(true);
  });
});
