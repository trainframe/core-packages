/**
 * Layout normalisation — close residual joint gaps in a loaded layout.
 *
 * Freshly-placed pieces snap their shared endpoints to coincide exactly (see
 * `computeMovePlacement`), so a layout built in this session has zero-gap joints.
 * A layout LOADED from a file (or authored before the coincide-snap existed) can
 * carry small residual gaps at its joints — most visibly at loop-closing seams,
 * where a chain returns to meet itself a few mm short. `buildJoints` still counts
 * those endpoints as a joint (they are within `SNAP_DISTANCE`), so the pieces are
 * logically connected yet render with a visible gap.
 *
 * `normalizeJointGaps` pulls each operator-made joint's two endpoints together so
 * the loaded layout renders connected — the same flush geometry fresh placement
 * produces. It is a pure, deterministic relaxation (fixed iterations, no RNG): the
 * joint topology is fixed from the input poses, then every piece is nudged toward
 * the midpoint of each joint it participates in (translation only — rotations, and
 * hence each rail's shape, are preserved). The averaging conserves the joints'
 * centroid, so the layout does not drift; pieces in no joint (an orphan, a train)
 * never move. Residual gaps at over-constrained seams (e.g. a junction's three
 * fixed-angle legs, which cannot all coincide) shrink to within the rail width.
 */

import type { JointId } from './loops.js';
import { buildJoints } from './loops.js';
import { type TrackPiece, getEndpoints } from './pieces.js';

/* Relaxation schedule. Fixed for determinism — 500 Gauss-Seidel-style sweeps at a
   0.7 step closes the test layout's 22mm loop residual to ~2mm (sub-rail-width) and
   converges to a stable fixed point (a re-run shifts nothing visible). */
const ITERATIONS = 500;
const STEP = 0.7;

/* Accumulated translation a piece should take this sweep, toward the midpoints of
   the joints it participates in. */
interface Shift {
  dx: number;
  dy: number;
  n: number;
}

/* Add one piece's pull toward a joint midpoint into the accumulator. */
function addPull(
  shift: Map<string, Shift>,
  id: string,
  mx: number,
  my: number,
  ex: number,
  ey: number,
): void {
  const s = shift.get(id) ?? { dx: 0, dy: 0, n: 0 };
  s.dx += mx - ex;
  s.dy += my - ey;
  s.n += 1;
  shift.set(id, s);
}

/* One relaxation sweep: pull each joint's two endpoints toward their shared
   midpoint, accumulate per-piece, then apply the averaged step. Mutates `pos`. */
function relaxSweep(
  joints: ReadonlyArray<JointId>,
  byId: ReadonlyMap<string, TrackPiece>,
  pos: Map<string, { x: number; y: number }>,
): void {
  const poseOf = (p: TrackPiece): TrackPiece => {
    const xy = pos.get(p.id);
    return xy === undefined ? p : { ...p, position: { x: xy.x, y: xy.y } };
  };
  const shift = new Map<string, Shift>();
  for (const j of joints) {
    const pa = byId.get(j.a.pieceId);
    const pb = byId.get(j.b.pieceId);
    if (pa === undefined || pb === undefined) continue;
    const ea = getEndpoints(poseOf(pa))[j.a.endpointIdx];
    const eb = getEndpoints(poseOf(pb))[j.b.endpointIdx];
    if (ea === undefined || eb === undefined) continue;
    const mx = (ea.x + eb.x) / 2;
    const my = (ea.y + eb.y) / 2;
    addPull(shift, pa.id, mx, my, ea.x, ea.y);
    addPull(shift, pb.id, mx, my, eb.x, eb.y);
  }
  for (const [id, s] of shift) {
    const xy = pos.get(id);
    if (xy === undefined || s.n === 0) continue;
    xy.x += (s.dx / s.n) * STEP;
    xy.y += (s.dy / s.n) * STEP;
  }
}

/**
 * Return a copy of `pieces` with every operator-made joint's endpoints pulled to
 * coincide as closely as the rigid piece shapes allow. Idempotent on an already
 * gap-free layout. Pure and deterministic.
 */
export function normalizeJointGaps(pieces: ReadonlyArray<TrackPiece>): TrackPiece[] {
  const joints = buildJoints(pieces);
  if (joints.length === 0) return pieces.map((p) => ({ ...p }));

  /* Mutable working positions, keyed by id; rotations are never touched. */
  const pos = new Map<string, { x: number; y: number }>();
  for (const p of pieces) pos.set(p.id, { x: p.position.x, y: p.position.y });
  const byId = new Map(pieces.map((p) => [p.id, p]));

  for (let iter = 0; iter < ITERATIONS; iter++) relaxSweep(joints, byId, pos);

  return pieces.map((p) => {
    const xy = pos.get(p.id);
    return xy === undefined ? { ...p } : { ...p, position: { x: xy.x, y: xy.y } };
  });
}
