import { describe, expect, it } from 'vitest';
import { type JibConfig, JibCrane } from './jib-crane.js';

/* A tower at (1000, 800) that can slew across the top half-plane and reach
 * 100…600 mm out along the boom. */
const CFG: JibConfig = {
  base: { x: 1000, y: 800 },
  limits: { minAngle: -Math.PI, maxAngle: Math.PI, minReach: 100, maxReach: 600 },
  start: { angle: -Math.PI / 2, reach: 300 },
};

/** Run the jib to its commanded target for up to `cap` seconds (1ms steps). */
function settle(jib: JibCrane, cap = 20): number {
  let t = 0;
  for (; t < cap && !jib.arrived; t += 0.001) jib.step(0.001);
  return t;
}

describe('JibCrane — a physically honest slewing dock crane', () => {
  it('starts at its commanded start, already arrived, hook at base + θ + r', () => {
    const j = new JibCrane(CFG);
    expect(j.arrived).toBe(true);
    /* θ = -π/2 (straight up in screen space), r = 300 → (1000, 800 - 300). */
    expect(j.pos.x).toBeCloseTo(1000, 3);
    expect(j.pos.y).toBeCloseTo(500, 3);
    expect(j.pivot).toEqual({ x: 1000, y: 800 });
  });

  it('derives the hook position from polar state (slew + reach → world)', () => {
    const j = new JibCrane(CFG);
    /* Slew to 0 rad (boom points along +x) at full reach. */
    j.moveTo(0, 600);
    settle(j);
    expect(j.slewAngle).toBeCloseTo(0, 2);
    expect(j.reachOut).toBeCloseTo(600, 0);
    expect(j.pos.x).toBeCloseTo(1600, 0);
    expect(j.pos.y).toBeCloseTo(800, 0);
  });

  it('takes real time to slew — it is not instantaneous', () => {
    const j = new JibCrane(CFG);
    const start = j.slewAngle;
    j.moveTo(0, 300);
    j.step(0.001);
    expect(j.slewAngle).toBeGreaterThan(start); // crept toward 0 from -π/2
    expect(j.slewAngle).toBeLessThan(start + 0.01);
    expect(j.arrived).toBe(false);
  });

  it('reaches and rests on its target without overshooting', () => {
    const j = new JibCrane(CFG);
    j.moveTo(-Math.PI / 4, 450);
    const t = settle(j);
    expect(j.arrived).toBe(true);
    expect(j.slewAngle).toBeCloseTo(-Math.PI / 4, 2);
    expect(j.reachOut).toBeCloseTo(450, 0);
    expect(t).toBeGreaterThan(0); // it took time
  });

  it('clamps a slew past its bearing endstops', () => {
    /* A jib whose boom may only swing across the upper-left quadrant. */
    const narrow = new JibCrane({
      base: { x: 1000, y: 800 },
      limits: { minAngle: -Math.PI, maxAngle: -Math.PI / 2, minReach: 100, maxReach: 600 },
      start: { angle: -Math.PI / 2, reach: 300 },
    });
    narrow.moveTo(0, 300); // 0 rad is well past maxAngle (-π/2)
    settle(narrow);
    expect(narrow.slewAngle).toBeCloseTo(-Math.PI / 2, 3); // jammed at the slew limit
  });

  it('clamps reach at the boom endstops (max and min)', () => {
    const far = new JibCrane(CFG);
    far.moveTo(-Math.PI / 2, 5000); // way past maxReach
    settle(far);
    expect(far.reachOut).toBeCloseTo(600, 0);

    const near = new JibCrane(CFG);
    near.moveTo(-Math.PI / 2, -100); // inside the tower, past minReach
    settle(near);
    expect(near.reachOut).toBeCloseTo(100, 0);
  });

  it('aimAt converts a reachable world point to (θ, r) and bears on it', () => {
    const j = new JibCrane(CFG);
    /* A point 200 mm to the left of the tower along the boom plane. */
    j.aimAt(800, 800);
    settle(j);
    expect(j.pos.x).toBeCloseTo(800, 0);
    expect(j.pos.y).toBeCloseTo(800, 0);
    /* Bearing straight left is ±π; normalise so either sign reads as π. */
    expect(Math.abs(j.slewAngle)).toBeCloseTo(Math.PI, 2);
  });

  it('aimAt clamps an out-of-reach point to the boom max, still bearing on it', () => {
    const j = new JibCrane(CFG);
    /* Straight up but 2000 mm away — beyond maxReach (600). */
    j.aimAt(1000, -1200);
    settle(j);
    expect(j.reachOut).toBeCloseTo(600, 0); // parked at the mechanical limit
    expect(j.slewAngle).toBeCloseTo(-Math.PI / 2, 2); // still aimed straight up
    /* Bears on the target direction, just short of it. */
    expect(j.pos.x).toBeCloseTo(1000, 0);
    expect(j.pos.y).toBeCloseTo(200, 0);
  });

  it('carries and releases a payload', () => {
    const j = new JibCrane(CFG);
    expect(j.carrying).toBe(false);
    j.grab();
    expect(j.carrying).toBe(true);
    expect(j.release()).toBe(true); // it WAS carrying → caller drops a body
    expect(j.carrying).toBe(false);
    expect(j.release()).toBe(false); // already empty → nothing to drop
  });
});
