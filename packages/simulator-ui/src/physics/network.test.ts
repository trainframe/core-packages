import { describe, expect, it } from 'vitest';
import { buildNetwork } from './network.js';
import type { Rail } from './rail.js';
import { PhysicsWorld } from './world.js';

/** A synthetic straight segment of the given length (geometry irrelevant to the
 *  traversal logic; we assert on which segment the body ends up). */
function seg(length: number): Rail {
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

/** A trunk that forks (at switch `J`) into `through` or `branch`. */
function junction(): PhysicsWorld {
  const segments = new Map<string, Rail>([
    ['trunk', seg(500)],
    ['through', seg(500)],
    ['branch', seg(500)],
  ]);
  const net = buildNetwork(segments, [
    { from: 'trunk', to: 'through', when: { switchId: 'J', position: 'through' } },
    { from: 'trunk', to: 'branch', when: { switchId: 'J', position: 'branch' } },
  ]);
  return new PhysicsWorld(net);
}

const run = (w: PhysicsWorld, steps: number) => {
  for (let i = 0; i < steps; i++) w.step(0.05);
};
const pose = (w: PhysicsWorld, id: string) => {
  const p = w.bodies().find((b) => b.id === id);
  if (!p) throw new Error(`no body ${id}`);
  return p;
};

describe('rail network — switch traversal', () => {
  it('a forward train takes the THROUGH route when the switch is set through', () => {
    const w = junction();
    w.setSwitch('J', 'through');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      motion: 'forward',
      segment: 'trunk',
    });
    run(w, 60);
    expect(pose(w, 'T').segment).toBe('through');
  });

  it('a forward train takes the BRANCH when the switch is set to branch', () => {
    const w = junction();
    w.setSwitch('J', 'branch');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      motion: 'forward',
      segment: 'trunk',
    });
    run(w, 60);
    expect(pose(w, 'T').segment).toBe('branch');
  });

  it('reports flipsFacing on a turn-around link, false on a plain one', () => {
    const segments = new Map<string, Rail>([
      ['trunk', seg(500)],
      ['deck', seg(500)],
    ]);
    const flip = buildNetwork(segments, [{ from: 'trunk', to: 'deck', flipsFacing: true }]);
    const ex = flip.exit('trunk', 'end', new Map());
    expect(ex).not.toBeNull();
    expect(ex?.flipsFacing).toBe(true);
    // The reverse direction of the same link also flips (the deck is turned either way).
    expect(flip.exit('deck', 'start', new Map())?.flipsFacing).toBe(true);

    const plain = buildNetwork(segments, [{ from: 'trunk', to: 'deck' }]);
    expect(plain.exit('trunk', 'end', new Map())?.flipsFacing).toBe(false);
  });

  it('reversing back off the branch returns to the trunk (same switch path)', () => {
    const w = junction();
    w.setSwitch('J', 'branch');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 450,
      facing: 1,
      motion: 'forward',
      segment: 'trunk',
    });
    run(w, 30); // cross onto the branch
    expect(pose(w, 'T').segment).toBe('branch');
    w.setMotion('T', 'reverse');
    run(w, 80); // back off the branch's start, onto the trunk
    expect(pose(w, 'T').segment).toBe('trunk');
  });
});
