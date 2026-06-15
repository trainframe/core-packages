import { describe, expect, it } from 'vitest';
import { countBridges } from '../track/overlap.js';
import { addCrossoverLoop } from './crossover-loop.js';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';
import { PhysicsWorld } from './world.js';

const STRAIGHT: PieceSpec = { type: 'straight' };

describe('addCrossoverLoop — a self-crossing teardrop on a bridge, spliced into a line', () => {
  it('builds, rejoins the line, and crosses over itself exactly once on a height layer', () => {
    const b = new PieceNetworkBuilder();
    const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
    const afterLead = b.run('lead', start, [STRAIGHT, STRAIGHT]);
    const loop = addCrossoverLoop(b, afterLead, { prefix: 'X', flipped: false });
    b.link('lead', loop.inbound);
    const afterTail = b.run('tail', loop.exit, [STRAIGHT, STRAIGHT]);
    b.link(loop.segments.mergeThrough, 'tail');
    b.link(loop.segments.mergeBranch, 'tail');

    const built = b.build(); // throws on any same-layer self-overlap
    expect(countBridges(built.pieces)).toBe(1); // exactly one grade-separated crossing
    /* The merged main carries on in the entry heading (east), back on the ground. */
    expect(afterTail.layer).toBe(0);
    expect(Math.abs(afterTail.dir % 360)).toBeLessThan(1);
  });

  it('a train driven onto the loop traverses the teardrop and rejoins (no derail)', () => {
    const b = new PieceNetworkBuilder();
    const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
    const afterLead = b.run('lead', start, [STRAIGHT, STRAIGHT]);
    const loop = addCrossoverLoop(b, afterLead, { prefix: 'X', flipped: false });
    b.link('lead', loop.inbound);
    b.run('tail', loop.exit, [STRAIGHT, STRAIGHT, STRAIGHT]);
    b.link(loop.segments.mergeThrough, 'tail');
    b.link(loop.segments.mergeBranch, 'tail');

    const world = new PhysicsWorld(b.build().net);
    world.setSwitch(loop.segments.switchId, loop.segments.loopPos); // divert onto the teardrop
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: 'lead',
      motion: 'forward',
      maxSpeed: 200,
    });

    const visited = new Set<string>();
    let reachedTailRailed = false;
    let derailed = false;
    for (let i = 0; i < 60 * 60 && !reachedTailRailed; i++) {
      world.step(1 / 60);
      const p = world.bodies()[0];
      if (p === undefined) continue;
      visited.add(p.segment);
      if (p.fate === 'derailed') derailed = true;
      /* Snapshot the instant it first reaches the onward line: it must still be
       *  railed there — i.e. it crossed the teardrop + bridge without derailing.
       *  (After this it runs off the deliberately open end; that's expected.) */
      if (p.segment === 'tail' && p.mode === 'railed') reachedTailRailed = true;
    }
    expect(visited.has(loop.segments.loop)).toBe(true); // it took the teardrop
    expect(derailed).toBe(false); // never derailed on the tight curves or the bridge
    expect(reachedTailRailed).toBe(true); // crossed over itself and rejoined, railed
  });
});
