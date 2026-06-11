import { describe, expect, it } from 'vitest';
import { buildRail } from './rail.js';
import { buildScenario } from './scenarios.js';

/** Pieces for a scenario, or fail loudly (scenarios are the real-piece source). */
function piecesOf(name: string) {
  const s = buildScenario(name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  return s.pieces;
}

describe('buildRail — from real placed pieces', () => {
  it('a chain of straights makes one continuous rail of the summed length', () => {
    const rail = buildRail(piecesOf('collision')); // 8 straights = 1600 mm
    expect(rail.length).toBeCloseTo(1600, 0);
    const start = rail.at(0);
    const end = rail.at(rail.length);
    expect(end.x - start.x).toBeCloseTo(1600, 0); // runs straight east
    expect(Math.abs(end.y - start.y)).toBeLessThan(1);
    expect(rail.startBuffered).toBe(false);
    expect(rail.endBuffered).toBe(false);
    expect(rail.curvatureAt(800)).toBeCloseTo(0, 3); // straight: no curvature
    expect(rail.pieceTypeAt(800)).toBe('straight');
  });

  it('a terminus at the end marks the rail end as buffered', () => {
    const rail = buildRail(piecesOf('terminus'));
    expect(rail.endBuffered).toBe(true);
    expect(rail.length).toBeCloseTo(1200, 0); // 6 straights; terminus adds the buffer
  });

  it('a curve reports real curvature (≈ 1/radius for the tight 100 mm curve)', () => {
    const rail = buildRail(piecesOf('derail'));
    // The chain ends in two 100 mm-radius curves; sample near the far end.
    const kappa = Math.abs(rail.curvatureAt(rail.length - 30));
    expect(kappa).toBeGreaterThan(1 / 200); // tighter than a default 200 mm curve
  });
});
