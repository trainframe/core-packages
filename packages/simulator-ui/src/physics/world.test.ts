import { describe, expect, it } from 'vitest';
import type { Rail } from './rail.js';
import { PhysicsWorld } from './world.js';

/** A synthetic straight rail along +x, for unit-testing the world in isolation. */
function straightRail(
  length: number,
  ends: { startBuffered?: boolean; endBuffered?: boolean } = {},
): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    startBuffered: ends.startBuffered ?? false,
    endBuffered: ends.endBuffered ?? false,
  };
}

/** A synthetic tight-curve rail (constant curvature) for the derail test. */
function curveRail(length: number, radiusMm: number): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: ((d / radiusMm) * 180) / Math.PI }),
    curvatureAt: () => 1 / radiusMm,
    pieceTypeAt: () => 'curve',
    startBuffered: false,
    endBuffered: false,
  };
}

const run = (w: PhysicsWorld, steps: number, dt = 0.05) => {
  for (let i = 0; i < steps; i++) w.step(dt);
};
const pose = (w: PhysicsWorld, id: string) => {
  const p = w.bodies().find((b) => b.id === id);
  if (!p) throw new Error(`no body ${id}`);
  return p;
};

describe('PhysicsWorld — contact', () => {
  it('two opposed locos collide and stop each other (no markers)', () => {
    const w = new PhysicsWorld(straightRail(1000));
    w.addBody({ id: 'A', kind: 'loco', railPos: 200, facing: 1, motion: 'forward' });
    w.addBody({ id: 'B', kind: 'loco', railPos: 800, facing: -1, motion: 'forward' });
    run(w, 200);
    const a = pose(w, 'A');
    const b = pose(w, 'B');
    expect(a.speed).toBeLessThan(1);
    expect(b.speed).toBeLessThan(1);
    // They stopped in contact, near the middle, not passing through each other.
    expect(b.x - a.x).toBeGreaterThan(50); // held apart by their extents
    expect(b.x - a.x).toBeLessThan(90);
    expect(a.x).toBeGreaterThan(200); // A advanced toward B
    expect(b.x).toBeLessThan(800); // B advanced toward A
  });

  it('a loco drives forward into a carriage and pushes it back', () => {
    const w = new PhysicsWorld(straightRail(2000));
    w.addBody({ id: 'L', kind: 'loco', railPos: 100, facing: 1, motion: 'forward' });
    w.addBody({ id: 'C', kind: 'carriage', railPos: 300, facing: 1 });
    run(w, 100);
    const l = pose(w, 'L');
    const c = pose(w, 'C');
    expect(c.x).toBeGreaterThan(600); // the carriage was shoved well forward
    expect(c.x - l.x).toBeGreaterThan(50); // still ahead, in contact
    expect(c.x - l.x).toBeLessThan(80);
    expect(c.coupledTo).toHaveLength(0); // pushed, NOT coupled
  });

  it('a loco reversing into a carriage magnetically couples', () => {
    const w = new PhysicsWorld(straightRail(2000));
    w.addBody({ id: 'L', kind: 'loco', railPos: 400, facing: 1, motion: 'reverse' });
    w.addBody({ id: 'C', kind: 'carriage', railPos: 200, facing: 1 });
    run(w, 18); // long enough to back onto C, short enough not to coast off the open end
    expect(pose(w, 'L').coupledTo).toContain('C');
    expect(pose(w, 'C').coupledTo).toContain('L');
  });
});

describe('PhysicsWorld — rail ends', () => {
  it('stops at a terminus buffer purely in the simulator (no marker, no core)', () => {
    const w = new PhysicsWorld(straightRail(500, { endBuffered: true }));
    w.addBody({ id: 'T', kind: 'loco', railPos: 100, facing: 1, motion: 'forward' });
    run(w, 300);
    const t = pose(w, 'T');
    expect(t.mode).toBe('railed');
    expect(t.fate).toBe('on-rail');
    expect(t.x).toBeCloseTo(500, 0); // parked at the buffer
    expect(t.speed).toBeLessThan(1);
  });

  it('runs off the end of unbuilt track into free space', () => {
    const w = new PhysicsWorld(straightRail(500, { endBuffered: false }));
    w.addBody({ id: 'T', kind: 'loco', railPos: 100, facing: 1, motion: 'forward' });
    run(w, 300);
    const t = pose(w, 'T');
    expect(t.fate).toBe('ran-off');
    expect(t.mode).toBe('free');
    expect(t.x).toBeGreaterThan(500); // coasted past where the rail ended
  });
});

describe('PhysicsWorld — derail', () => {
  it('a body taking a curve too fast derails off the rail', () => {
    // 100 mm radius curve; a fast loco should exceed the lateral limit.
    const w = new PhysicsWorld(curveRail(2000, 100));
    w.addBody({
      id: 'F',
      kind: 'loco',
      railPos: 50,
      facing: 1,
      motion: 'forward',
      maxSpeed: 1500,
      accel: 4000,
    });
    run(w, 60);
    expect(pose(w, 'F').fate).toBe('derailed');
    expect(pose(w, 'F').mode).toBe('free');
  });

  it('a body holding a gentle curve at low speed stays on the rail', () => {
    const w = new PhysicsWorld(curveRail(2000, 600));
    w.addBody({
      id: 'S',
      kind: 'loco',
      railPos: 50,
      facing: 1,
      motion: 'forward',
      maxSpeed: 300,
      accel: 800,
    });
    run(w, 120);
    expect(pose(w, 'S').fate).toBe('on-rail');
  });
});

describe('PhysicsWorld — tug of war (traction power)', () => {
  it('equal power, opposed, coupled to one carriage → stalemate', () => {
    const w = new PhysicsWorld(straightRail(2000));
    w.addBody({ id: 'A', kind: 'loco', railPos: 900, facing: -1, motion: 'forward', power: 100 });
    w.addBody({ id: 'M', kind: 'carriage', railPos: 1000, facing: 1 });
    w.addBody({ id: 'B', kind: 'loco', railPos: 1100, facing: 1, motion: 'forward', power: 100 });
    // Pre-couple the rake: A—M—B.
    w.couple('A', 'M');
    w.couple('M', 'B');
    const x0 = pose(w, 'M').x;
    run(w, 100);
    expect(Math.abs(pose(w, 'M').x - x0)).toBeLessThan(5); // nobody wins
  });

  it('unequal power → the stronger loco wins and drags the rake its way', () => {
    const w = new PhysicsWorld(straightRail(4000));
    w.addBody({ id: 'A', kind: 'loco', railPos: 1900, facing: -1, motion: 'forward', power: 60 });
    w.addBody({ id: 'M', kind: 'carriage', railPos: 2000, facing: 1 });
    w.addBody({ id: 'B', kind: 'loco', railPos: 2100, facing: 1, motion: 'forward', power: 140 });
    w.couple('A', 'M');
    w.couple('M', 'B');
    const x0 = pose(w, 'M').x;
    run(w, 100);
    expect(pose(w, 'M').x).toBeGreaterThan(x0 + 50); // B (facing +) drags it +x
  });
});
