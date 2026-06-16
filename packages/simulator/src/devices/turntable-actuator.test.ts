import { describe, expect, it } from 'vitest';
import type { SwitchActuator } from './switch-actuator.js';
import { TurntableActuator, type TurntableExit } from './turntable-actuator.js';

/** A recording switch actuator: captures every position the deck commits. */
function recordingSwitch(): { points: SwitchActuator; log: string[] } {
  const log: string[] = [];
  return { points: { set: (p) => log.push(p) }, log };
}

const EXITS: readonly TurntableExit[] = [
  { position: 'trunk', angleDeg: 0 },
  { position: 'stub-e', angleDeg: 180 },
  { position: 'stub-n', angleDeg: 135 },
];

function deck(
  startDeg = 0,
  limits = { minDeg: 0, maxDeg: 360 },
): { d: TurntableActuator; log: string[] } {
  const { points, log } = recordingSwitch();
  const d = new TurntableActuator({ exits: EXITS, switchId: 'Jt', points, limits, startDeg });
  return { d, log };
}

/** Run the deck for up to `cap` seconds (1ms steps), stopping when it arrives. */
function settle(d: TurntableActuator, cap = 20): number {
  let t = 0;
  for (; t < cap && !d.arrived; t += 0.001) d.step(0.001);
  return t;
}

describe('TurntableActuator — physically-honest rotation', () => {
  it('starts seated on whatever exit it lines up with, switch thrown', () => {
    const { d, log } = deck(0);
    expect(d.pos).toBe(0);
    expect(d.arrived).toBe(true);
    expect(d.alignedExit).toBe('trunk');
    expect(log).toEqual(['trunk']); // committed the starting alignment
  });

  it('takes real time to swing — it is not instantaneous', () => {
    const { d } = deck(0);
    d.alignTo('stub-e'); // 0 → 180°
    d.step(0.001);
    expect(d.pos).toBeGreaterThan(0);
    expect(d.pos).toBeLessThan(2);
    expect(d.arrived).toBe(false);
    expect(d.alignedExit).toBeNull(); // mid-swing: nothing aligned, train held off
  });

  it('accelerates: it covers more ground in later steps than the first', () => {
    const { d } = deck(0);
    d.alignTo('stub-e');
    d.step(0.05);
    const first = d.pos;
    d.step(0.05);
    expect(d.pos - first).toBeGreaterThan(first);
  });

  it('reaches the target angle and seats the exit (commits the switch) — only then', () => {
    const { d, log } = deck(0);
    d.alignTo('stub-e');
    expect(log).toEqual(['trunk']); // not committed yet — still at the trunk
    const t = settle(d);
    expect(t).toBeGreaterThan(0); // it took time
    expect(d.pos).toBeCloseTo(180, 0);
    expect(d.arrived).toBe(true);
    expect(d.alignedExit).toBe('stub-e');
    expect(log).toEqual(['trunk', 'stub-e']); // committed exactly once, on seating
  });

  it('does not overshoot the target', () => {
    const { d } = deck(0);
    d.alignTo('stub-n'); // 135°
    let maxSeen = 0;
    for (let i = 0; i < 20000 && !d.arrived; i++) {
      d.step(0.001);
      maxSeen = Math.max(maxSeen, d.pos);
    }
    expect(maxSeen).toBeLessThanOrEqual(135 + 0.5);
    expect(d.pos).toBeCloseTo(135, 0);
  });

  it('clamps a commanded angle past its endstops, jamming at the limit', () => {
    const { d } = deck(40, { minDeg: 0, maxDeg: 90 });
    d.rotateTo(400); // way past the max endstop
    settle(d);
    expect(d.pos).toBeCloseTo(90, 0); // jammed at the limit, not at 400
  });

  it('rejects an unknown exit', () => {
    const { d } = deck(0);
    expect(() => d.alignTo('nope')).toThrow(/no exit/);
  });
});
