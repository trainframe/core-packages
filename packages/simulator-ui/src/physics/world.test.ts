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
    slopeAt: () => 0,
    startBuffered: ends.startBuffered ?? false,
    endBuffered: ends.endBuffered ?? false,
  };
}

/** A synthetic constant-slope rail: +1 climbs in +x, -1 descends. */
function slopeRail(length: number, slope: number): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
    curvatureAt: () => 0,
    pieceTypeAt: () => (slope === 0 ? 'straight' : 'ramp'),
    slopeAt: () => slope,
    startBuffered: false,
    endBuffered: false,
  };
}

/** A synthetic tight-curve rail (constant curvature) for the derail test. */
function curveRail(length: number, radiusMm: number): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: ((d / radiusMm) * 180) / Math.PI }),
    curvatureAt: () => 1 / radiusMm,
    pieceTypeAt: () => 'curve',
    slopeAt: () => 0,
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
    expect(b.x - a.x).toBeGreaterThan(50); // held apart by their extents
    expect(b.x - a.x).toBeLessThan(90);
    expect(a.x).toBeGreaterThan(200);
    expect(b.x).toBeLessThan(800);
  });

  it('a loco drives forward into a carriage and pushes it back', () => {
    const w = new PhysicsWorld(straightRail(3000));
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
    run(w, 22); // back onto C, short enough not to coast off the open start end
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
    expect(t.x).toBeCloseTo(500, 0);
    expect(t.speed).toBeLessThan(1);
  });

  it('runs off the end of unbuilt track into free space', () => {
    const w = new PhysicsWorld(straightRail(500, { endBuffered: false }));
    w.addBody({ id: 'T', kind: 'loco', railPos: 100, facing: 1, motion: 'forward' });
    run(w, 300);
    const t = pose(w, 'T');
    expect(t.fate).toBe('ran-off');
    expect(t.mode).toBe('free');
    expect(t.x).toBeGreaterThan(500);
  });
});

describe('PhysicsWorld — derail', () => {
  it('a body taking a curve too fast derails off the rail', () => {
    const w = new PhysicsWorld(curveRail(2000, 100));
    w.addBody({ id: 'F', kind: 'loco', railPos: 50, facing: 1, motion: 'forward', power: 3200 });
    run(w, 60);
    expect(pose(w, 'F').fate).toBe('derailed');
    expect(pose(w, 'F').mode).toBe('free');
  });

  it('a body holding a gentle curve at low speed stays on the rail', () => {
    const w = new PhysicsWorld(curveRail(4000, 600));
    w.addBody({ id: 'S', kind: 'loco', railPos: 50, facing: 1, motion: 'forward' });
    run(w, 100); // long, gentle rail — neither derails nor reaches the far end
    expect(pose(w, 'S').fate).toBe('on-rail');
  });
});

describe('PhysicsWorld — tug of war (traction power)', () => {
  it('equal power, opposed, coupled to one carriage → stalemate', () => {
    const w = new PhysicsWorld(straightRail(2000));
    w.addBody({ id: 'A', kind: 'loco', railPos: 900, facing: -1, motion: 'forward', power: 100 });
    w.addBody({ id: 'M', kind: 'carriage', railPos: 1000, facing: 1 });
    w.addBody({ id: 'B', kind: 'loco', railPos: 1100, facing: 1, motion: 'forward', power: 100 });
    w.couple('A', 'M');
    w.couple('M', 'B');
    const x0 = pose(w, 'M').x;
    run(w, 100);
    expect(Math.abs(pose(w, 'M').x - x0)).toBeLessThan(5);
  });

  it('the stronger loco wins and drags the rake its way', () => {
    const w = new PhysicsWorld(straightRail(4000));
    w.addBody({ id: 'A', kind: 'loco', railPos: 1900, facing: -1, motion: 'forward', power: 80 });
    w.addBody({ id: 'M', kind: 'carriage', railPos: 2000, facing: 1 });
    w.addBody({ id: 'B', kind: 'loco', railPos: 2100, facing: 1, motion: 'forward', power: 260 });
    w.couple('A', 'M');
    w.couple('M', 'B');
    const x0 = pose(w, 'M').x;
    run(w, 140);
    expect(pose(w, 'M').x).toBeGreaterThan(x0 + 50); // B (facing +) drags it +x
  });
});

describe('PhysicsWorld — load (carriage weight)', () => {
  /** How far an identical loco travels in a fixed time pulling `n` carriages. */
  const distanceWith = (n: number): number => {
    const w = new PhysicsWorld(straightRail(6000));
    w.addBody({ id: 'L', kind: 'loco', railPos: 500, facing: 1, motion: 'forward' });
    for (let i = 0; i < n; i++) {
      w.addBody({ id: `c${i}`, kind: 'carriage', railPos: 500 - (i + 1) * 68, facing: 1 });
      w.couple(i === 0 ? 'L' : `c${i - 1}`, `c${i}`);
    }
    run(w, 120); // 6 s
    return pose(w, 'L').x;
  };

  it('a train pulling more carriages travels slower (less far) than a lighter one', () => {
    const d0 = distanceWith(0);
    const d2 = distanceWith(2);
    const d4 = distanceWith(4);
    expect(d0).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThan(d4);
  });

  it('a stronger loco outpulls a weaker one under the same load', () => {
    const dist = (power: number): number => {
      const w = new PhysicsWorld(straightRail(8000));
      w.addBody({ id: 'L', kind: 'loco', railPos: 500, facing: 1, motion: 'forward', power });
      w.addBody({ id: 'c0', kind: 'carriage', railPos: 432, facing: 1 });
      w.addBody({ id: 'c1', kind: 'carriage', railPos: 364, facing: 1 });
      w.couple('L', 'c0');
      w.couple('c0', 'c1');
      run(w, 120);
      return pose(w, 'L').x;
    };
    expect(dist(1400)).toBeGreaterThan(dist(700)); // more power → further with the same rake
  });
});

describe('PhysicsWorld — uncouple (the crane wedge)', () => {
  it('splitting a coupling leaves the rear cut behind as the loco pulls away', () => {
    const w = new PhysicsWorld(straightRail(4000));
    w.addBody({ id: 'L', kind: 'loco', railPos: 300, facing: 1, motion: 'forward' });
    w.addBody({ id: 'c0', kind: 'carriage', railPos: 232, facing: 1 });
    w.addBody({ id: 'c1', kind: 'carriage', railPos: 164, facing: 1 });
    w.couple('L', 'c0');
    w.couple('c0', 'c1');
    w.uncouple('c0', 'c1'); // the wedge prises the rear coupling apart
    const c1Before = pose(w, 'c1').x;
    run(w, 60);
    expect(pose(w, 'L').coupledTo).toEqual(['c0']); // loco + front car still a unit
    expect(pose(w, 'c0').coupledTo).not.toContain('c1');
    expect(pose(w, 'L').x).toBeGreaterThan(360); // pulled forward, away from the cut
    expect(Math.abs(pose(w, 'c1').x - c1Before)).toBeLessThan(5); // shed cut sits put
  });
});

describe('PhysicsWorld — gravity on ramps', () => {
  /** Steady speed of an identical loco on a rail of the given slope. */
  const steadySpeed = (slope: number): number => {
    const w = new PhysicsWorld(slopeRail(9000, slope));
    w.addBody({ id: 'L', kind: 'loco', railPos: 100, facing: 1, motion: 'forward' });
    run(w, 160); // 8 s — reach steady speed
    return pose(w, 'L').speed;
  };

  it('climbs a ramp slower than the level, and descends a little faster', () => {
    const up = steadySpeed(1);
    const flat = steadySpeed(0);
    const down = steadySpeed(-1);
    expect(up).toBeLessThan(flat);
    expect(flat).toBeLessThan(down);
  });
});
