import { describe, expect, it } from 'vitest';
import { buildRail } from './rail.js';
import { SCENARIO_NAMES, buildScenario } from './scenarios.js';
import { PhysicsWorld } from './world.js';

describe('physics scenarios', () => {
  it('exposes the seven acceptance scenarios', () => {
    expect(SCENARIO_NAMES).toEqual(
      expect.arrayContaining([
        'collision',
        'push',
        'terminus',
        'couple',
        'tugofwar',
        'derail',
        'runoff',
      ]),
    );
    expect(SCENARIO_NAMES).toHaveLength(7);
  });

  it('an unknown scenario is undefined', () => {
    expect(buildScenario('nope')).toBeUndefined();
  });

  for (const name of SCENARIO_NAMES) {
    it(`${name}: builds real pieces + bodies and stages into a world without throwing`, () => {
      const s = buildScenario(name);
      expect(s).toBeDefined();
      if (s === undefined) return;
      expect(s.pieces.length).toBeGreaterThan(0);
      expect(s.bodies.length).toBeGreaterThan(0);
      expect(s.durationS).toBeGreaterThan(0);
      // The rail + world build and step cleanly (no NaN positions) — proves the
      // scenario's pieces actually chain into a drivable rail.
      const world = new PhysicsWorld(buildRail(s.pieces));
      for (const b of s.bodies) world.addBody(b);
      for (const [a, b] of s.couples) world.couple(a, b);
      for (let i = 0; i < 20; i++) world.step(1 / 60);
      for (const pose of world.bodies()) {
        expect(Number.isFinite(pose.x)).toBe(true);
        expect(Number.isFinite(pose.y)).toBe(true);
      }
    });
  }
});
