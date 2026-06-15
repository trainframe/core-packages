import { describe, expect, it } from 'vitest';
import { buildPassingLoopScene } from './passing-loop.js';
import { PhysicsWorld } from './world.js';

/** Drive a train from the approach with the passing-loop switch at `pos`; return
 *  the set of segments it visited and whether it reached the departure. */
function driveRoute(pos: string): {
  visited: Set<string>;
  reachedExit: boolean;
  leftRails: boolean;
} {
  const scene = buildPassingLoopScene();
  const world = new PhysicsWorld(scene.net);
  world.setSwitch(scene.segments.switchId, pos);
  world.addBody({
    id: 'T',
    kind: 'loco',
    railPos: 10,
    facing: 1,
    segment: scene.entrySegment,
    color: 'red',
    motion: 'forward',
    maxSpeed: 200,
  });
  const visited = new Set<string>();
  let leftRails = false;
  const DT = 1 / 60;
  for (let i = 0; i < 60 * 30; i++) {
    world.step(DT);
    const b = world.bodies()[0];
    if (b === undefined) continue;
    if (b.fate !== 'on-rail' || b.mode !== 'railed') leftRails = true;
    visited.add(b.segment);
    if (b.segment === scene.exitSegment) break;
  }
  return { visited, reachedExit: visited.has(scene.exitSegment), leftRails };
}

describe('passing loop — a real-piece junction that diverts and rejoins', () => {
  it('closes geometrically: both routes rejoin the trailing turnout within 1 mm', () => {
    const scene = buildPassingLoopScene();
    const g = (id: string): { start: { x: number; y: number }; end: { x: number; y: number } } => {
      const e = scene.geom.get(id);
      if (e === undefined) throw new Error(`no geom for ${id}`);
      return e;
    };
    const gap = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
      Math.hypot(a.x - b.x, a.y - b.y);
    /* The straight main ends exactly where the trailing turnout's through path begins. */
    expect(gap(g(scene.segments.mainMid).end, g(scene.segments.mergeThrough).start)).toBeLessThan(
      1,
    );
    /* The siding ends exactly where the trailing turnout's branch path begins. */
    expect(gap(g(scene.segments.loop).end, g(scene.segments.mergeBranch).start)).toBeLessThan(1);
    /* Both trailing paths converge on the same trunk point (the merged main). */
    expect(gap(g(scene.segments.mergeThrough).end, g(scene.segments.mergeBranch).end)).toBeLessThan(
      1,
    );
  });

  it('the switch selects the main route — straight through, never onto the siding', () => {
    const r = driveRoute('main');
    expect(r.leftRails).toBe(false);
    expect(r.reachedExit).toBe(true);
    expect(r.visited.has('PL-mid')).toBe(true); // took the straight main
    expect(r.visited.has('PL-loop')).toBe(false); // did NOT divert onto the siding
  });

  it('the switch selects the loop route — diverts round the siding and rejoins', () => {
    const r = driveRoute('loop');
    expect(r.leftRails).toBe(false);
    expect(r.reachedExit).toBe(true);
    expect(r.visited.has('PL-loop')).toBe(true); // diverted onto the siding
    expect(r.visited.has('PL-mid')).toBe(false); // did NOT stay on the straight main
  });
});
