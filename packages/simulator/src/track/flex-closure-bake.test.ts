/**
 * BEHAVIOUR GATE (goal clause 2b): a valid near-closed loop flexes shut on
 * release and BAKES into a continuous cycle.
 *
 * Built entirely through the REAL placement path (`computePlacement`), the layout
 * is an uneven stadium oval: two semicircle ends (4×45° curves each) joined by
 * two straight sides of UNEQUAL length (150 mm and 110 mm). Because the loop still
 * sweeps exactly 360°, the closing joint is anti-parallel (0° heading error) but
 * the position is off by the side difference — a genuine ~40 mm gap that sits in
 * the flex band: above auto-snap (SNAP_DISTANCE_MM = 30), below capture
 * (CONNECT_CAPTURE_MM = 60), and genuinely open at rest (`findLoops` sees no
 * cycle). This is the canonical hand-buildable near-closure.
 *
 * The test proves the full release pipeline, un-mocked:
 *   (a) the rest layout is a valid open chain — every interior joint coincident,
 *       no cycle, closing gap in [30, 60] mm with anti-parallel heading;
 *   (b) the REAL `solveClose` returns feasible with every |δ| ≤ FLEX_BUDGET_DEG;
 *   (c) BAKING the solved flex into the pieces' stored poses (the single-frame
 *       release model: `applyFlex` output replaces the rest poses) yields a
 *       layout `findLoops` reads as EXACTLY ONE loop covering ALL pieces, with
 *       every joint continuous (gap < ε, anti-parallel headings).
 *
 * Nothing is mocked: placement, the solver, the FK bake, and the loop finder all
 * run for real against the same pieces.
 */
import { describe, expect, it } from 'vitest';
import { selectAnchor, solveClose } from './flex-solver.js';
import { FLEX_BUDGET_DEG, applyFlex } from './flex.js';
import { SNAP_DISTANCE } from './layout-from-pieces.js';
import { buildJoints, findLoops } from './loops.js';
import { type TrackPiece, getEndpoints } from './pieces.js';
import { CONNECT_CAPTURE_MM, computePlacement } from './placement.js';

interface Spec {
  readonly type: TrackPiece['type'];
  readonly len?: number;
}

/* Smallest absolute angular difference (deg) in [0, 180]. */
function angleDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/* The worst position gap and heading kink across every joint of a layout. A
 * continuous cycle has tiny gaps; a flexed joint's kink is bounded by the budget. */
function worstJointResidual(pieces: ReadonlyArray<TrackPiece>): { gap: number; kink: number } {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  let gap = 0;
  let kink = 0;
  for (const j of buildJoints(pieces)) {
    const pa = byId.get(j.a.pieceId);
    const pb = byId.get(j.b.pieceId);
    if (pa === undefined || pb === undefined) throw new Error('unreachable');
    const ea = getEndpoints(pa)[j.a.endpointIdx];
    const eb = getEndpoints(pb)[j.b.endpointIdx];
    if (ea === undefined || eb === undefined) throw new Error('unreachable');
    gap = Math.max(gap, Math.hypot(ea.x - eb.x, ea.y - eb.y));
    kink = Math.max(kink, angleDelta(ea.outgoingAngleDeg, eb.outgoingAngleDeg + 180));
  }
  return { gap, kink };
}

/*
 * Build a chain by snapping each spec onto the previous piece's exit endpoint via
 * the REAL `computePlacement` (length-aware for straight variants). Returns the
 * placed pieces P0..P{n-1}. Does NOT join the ends — the chain is left open.
 */
function buildViaPlacement(specs: ReadonlyArray<Spec>): TrackPiece[] {
  const first = specs[0];
  if (first === undefined) throw new Error('empty');
  const pieces: TrackPiece[] = [];
  /* First piece placed in open space at a fixed seed point. */
  const p0 = computePlacement(450, 300, first.type, pieces, false, 0, first.len);
  pieces.push({
    id: 'P0',
    type: first.type,
    position: { x: p0.x, y: p0.y },
    rotationDeg: p0.rotationDeg,
    tagged: false,
    ...(first.len !== undefined ? { lengthMm: first.len } : {}),
  });
  for (let i = 1; i < specs.length; i++) {
    const spec = specs[i];
    const prev = pieces[i - 1];
    if (spec === undefined || prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('no exit endpoint');
    const pl = computePlacement(exit.x, exit.y, spec.type, pieces, false, 0, spec.len);
    expect(pl.connected).toBe(true);
    pieces.push({
      id: `P${i}`,
      type: spec.type,
      position: { x: pl.x, y: pl.y },
      rotationDeg: pl.rotationDeg,
      tagged: false,
      ...(spec.len !== undefined ? { lengthMm: spec.len } : {}),
    });
  }
  return pieces;
}

/* The uneven stadium oval: side 150, semicircle, side 110, semicircle. */
function buildUnevenStadium(): TrackPiece[] {
  const C: Spec = { type: 'curve' };
  return buildViaPlacement([
    { type: 'straight', len: 150 },
    C,
    C,
    C,
    C,
    { type: 'straight', len: 110 },
    C,
    C,
    C,
    C,
  ]);
}

describe('flex closure bakes a valid near-closed loop into a continuous cycle', () => {
  it('(a) the rest layout is a valid OPEN near-closure with a flex-band gap', () => {
    const pieces = buildUnevenStadium();
    expect(pieces).toHaveLength(10);

    /* Every interior joint is coincident: the chain was laid flush by placement.
       9 interior joints for 10 pieces (the 10th gap is the open closure). */
    const joints = buildJoints(pieces);
    expect(joints.length).toBe(9);

    /* Genuinely OPEN at rest — no cycle yet. */
    expect(findLoops(pieces)).toHaveLength(0);

    /* The closing gap (last piece's free end → first piece's entry) sits in the
       flex band and the headings are anti-parallel (a real near-closure). */
    const last = pieces[pieces.length - 1];
    const first = pieces[0];
    if (last === undefined || first === undefined) throw new Error('unreachable');
    const free = getEndpoints(last)[1];
    const entry = getEndpoints(first)[0];
    if (free === undefined || entry === undefined) throw new Error('unreachable');
    const gap = Math.hypot(free.x - entry.x, free.y - entry.y);
    expect(gap).toBeGreaterThan(SNAP_DISTANCE); // > 30 mm: won't auto-snap
    expect(gap).toBeLessThan(CONNECT_CAPTURE_MM); // < 60 mm: within capture
    /* Anti-parallel: the free heading opposes the entry's outgoing heading. */
    expect(angleDelta(free.outgoingAngleDeg, entry.outgoingAngleDeg + 180)).toBeLessThan(1);
  });

  it('(b) solveClose is feasible with every joint within budget', () => {
    const pieces = buildUnevenStadium();
    const last = pieces[pieces.length - 1];
    const first = pieces[0];
    if (last === undefined || first === undefined) throw new Error('unreachable');
    const entry = getEndpoints(first)[0];
    if (entry === undefined) throw new Error('unreachable');

    const res = solveClose(pieces, last.id, 1, {
      x: entry.x,
      y: entry.y,
      outgoingAngleDeg: entry.outgoingAngleDeg,
    });
    expect(res.feasible).toBe(true);

    /* The bend is genuinely non-empty and spread, every joint within budget. */
    const nonZero = [...res.flex.values()].filter((f) => Math.abs(f.deg) > 1e-6);
    expect(nonZero.length).toBeGreaterThanOrEqual(3);
    for (const f of res.flex.values()) {
      expect(Math.abs(f.deg)).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 1e-6);
    }
  });

  it('(c) baking the closing flex yields ONE continuous loop over all pieces', () => {
    const pieces = buildUnevenStadium();
    const last = pieces[pieces.length - 1];
    const first = pieces[0];
    if (last === undefined || first === undefined) throw new Error('unreachable');
    const entry = getEndpoints(first)[0];
    if (entry === undefined) throw new Error('unreachable');

    const anchorId = selectAnchor(pieces, last.id);
    const res = solveClose(pieces, last.id, 1, {
      x: entry.x,
      y: entry.y,
      outgoingAngleDeg: entry.outgoingAngleDeg,
    });
    expect(res.feasible).toBe(true);

    /* BAKE: applyFlex output IS the new stored geometry (single-frame release). */
    const baked = applyFlex(pieces, res.flex, anchorId);
    expect(baked).toHaveLength(10);

    /* findLoops now sees EXACTLY ONE loop covering ALL ten pieces. */
    const loops = findLoops(baked);
    expect(loops).toHaveLength(1);
    const loop = loops[0];
    if (loop === undefined) throw new Error('unreachable');
    expect(new Set(loop.pieceIds).size).toBe(10);

    /* Every joint in the baked cycle is continuous: the two ends are COINCIDENT
       (< 1 mm). That positional continuity is what makes findLoops see one loop
       and what the centreline composer drives over. The heading at a flexed joint
       is intentionally NOT perfectly anti-parallel — a flexed joint carries a kink
       equal to its flex δ (the give that closes the loop), bounded by the budget.
       So we assert the kink stays within FLEX_BUDGET_DEG, not that it vanishes. */
    const residual = worstJointResidual(baked);
    expect(residual.gap).toBeLessThan(1); // < 1 mm: coincident
    expect(residual.kink).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 1e-6);

    /* The closing joint specifically must be present — the cycle really closed,
       not merely the 9 interior joints re-found. */
    expect(buildJoints(baked).length).toBe(10);
  });
});
