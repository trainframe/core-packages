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

  it('a SINGLE straight (no neighbours) makes a full-length rail, not a degenerate stub', () => {
    /* Regression: a lone piece has neither prev nor next, so endpoint resolution
     *  must still pick the two distinct default endpoints (0 → 1) and span the
     *  whole piece. A single-piece run (a passing-loop / yard inbound stub) used to
     *  collapse to a zero-length rail at the origin. */
    const straight = {
      id: 's',
      type: 'straight' as const,
      position: { x: 100, y: 50 },
      rotationDeg: 0 as const,
      tagged: false,
    };
    const rail = buildRail([straight]);
    expect(rail.length).toBeCloseTo(200, 0);
    /* The straight spans its full 200 mm (centred on `position`), level. */
    expect(rail.at(rail.length).x - rail.at(0).x).toBeCloseTo(200, 0);
    expect(rail.at(0).y).toBeCloseTo(50, 0);
    expect(rail.at(rail.length).y).toBeCloseTo(50, 0);
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
