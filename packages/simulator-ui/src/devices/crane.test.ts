import { describe, expect, it } from 'vitest';
import { Crane, type CraneBounds } from './crane.js';

const BOUNDS: CraneBounds = { minX: 0, maxX: 1000, minY: 0, maxY: 500 };

/** Run the crane to a commanded target for up to `cap` seconds (1ms steps). */
function settle(crane: Crane, cap = 10): number {
  let t = 0;
  for (; t < cap && !crane.arrived; t += 0.001) crane.step(0.001);
  return t;
}

describe('Crane — a physical XY gantry', () => {
  it('starts at its commanded start, already arrived', () => {
    const c = new Crane(BOUNDS, { x: 100, y: 100 });
    expect(c.pos).toEqual({ x: 100, y: 100 });
    expect(c.arrived).toBe(true);
  });

  it('takes real time to travel — it is not instantaneous', () => {
    const c = new Crane(BOUNDS, { x: 0, y: 0 });
    c.moveTo(800, 400);
    c.step(0.001);
    /* One millisecond in, it has barely moved off the start. */
    expect(c.pos.x).toBeGreaterThan(0);
    expect(c.pos.x).toBeLessThan(5);
    expect(c.arrived).toBe(false);
  });

  it('accelerates: it covers more ground in later steps than the first', () => {
    const c = new Crane(BOUNDS, { x: 0, y: 250 });
    c.moveTo(1000, 250);
    c.step(0.01);
    const firstLeg = c.pos.x;
    c.step(0.01);
    const secondLeg = c.pos.x - firstLeg;
    expect(secondLeg).toBeGreaterThan(firstLeg);
  });

  it('reaches and rests on its target without overshooting', () => {
    const c = new Crane(BOUNDS, { x: 50, y: 50 });
    c.moveTo(700, 300);
    const t = settle(c);
    expect(c.arrived).toBe(true);
    expect(c.pos.x).toBeCloseTo(700, 0);
    expect(c.pos.y).toBeCloseTo(300, 0);
    expect(t).toBeGreaterThan(0); // it took time
  });

  it('clamps a move past its endstops, jamming at the limit', () => {
    const c = new Crane(BOUNDS, { x: 500, y: 250 });
    c.moveTo(5000, -5000); // way beyond both limits
    settle(c);
    expect(c.pos.x).toBeCloseTo(BOUNDS.maxX, 0);
    expect(c.pos.y).toBeCloseTo(BOUNDS.minY, 0);
  });

  it('clamps its start position into bounds too', () => {
    const c = new Crane(BOUNDS, { x: -200, y: 9000 });
    expect(c.pos.x).toBe(BOUNDS.minX);
    expect(c.pos.y).toBe(BOUNDS.maxY);
  });
});
