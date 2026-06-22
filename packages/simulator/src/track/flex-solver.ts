/**
 * Flex solver: anchor selection, damped-least-squares (Levenberg–Marquardt)
 * follow-cursor relaxation, and loop-closure feasibility check.
 *
 * The solver operates on the joint graph built by `buildJoints`. It treats
 * each joint along the anchor→dragged chain as a rotational degree of freedom
 * bounded to ±FLEX_BUDGET_DEG. The chain's free endpoint pose is a function of
 * the per-joint δ vector; the solver drives that pose onto a target (position,
 * and — for closure — heading) by iterated damped-least-squares IK steps over
 * the δ vector. Unlike classic CCD, DLS damping keeps the step well-conditioned
 * on long, near-closed chains (≥5 joints, including the 8-curve ring) where CCD
 * diverges. Pure, deterministic, no I/O, no randomness.
 */

import {
  FLEX_BUDGET_DEG,
  type FlexState,
  type JointFlex,
  effectivePoses,
  jointKey,
} from './flex.js';
import type { JointId } from './loops.js';
import { buildJoints } from './loops.js';
import { getEndpointsAt } from './pieces.js';
import type { TrackPiece } from './pieces.js';

/* Maximum DLS iterations before we stop (keeps runtime bounded). */
const MAX_ITERATIONS = 30;

/* Finite-difference perturbation per joint, in degrees, for the Jacobian. */
const FD_EPS_DEG = 1e-3;

/* Convergence tolerance on the weighted error norm (the loop stops below it). */
const ERR_TOL = 1e-4;

/*
 * Heading weight: a per-radian heading error is scaled by this lever arm (mm)
 * so it is commensurate with positional error in the combined error vector.
 * A few hundred mm matches the arc radii in play, so position and heading are
 * driven together without either swamping the other.
 */
const HEADING_LEVER_MM = 150;

/* ---------------------------------------------------------------------------
 * Internal graph helpers
 * --------------------------------------------------------------------------- */

interface AdjEntry {
  readonly neighbourId: string;
  readonly joint: JointId;
}

function buildAdj(
  pieces: ReadonlyArray<TrackPiece>,
  joints: ReadonlyArray<JointId>,
): Map<string, AdjEntry[]> {
  const adj = new Map<string, AdjEntry[]>();
  for (const p of pieces) adj.set(p.id, []);
  for (const j of joints) {
    adj.get(j.a.pieceId)?.push({ neighbourId: j.b.pieceId, joint: j });
    adj.get(j.b.pieceId)?.push({ neighbourId: j.a.pieceId, joint: j });
  }
  return adj;
}

/* BFS from `startId` over `adj`; returns BFS distance map. */
function bfsDistances(startId: string, adj: Map<string, AdjEntry[]>): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(startId, 0);
  const queue: string[] = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const d = dist.get(current) ?? 0;
    for (const entry of adj.get(current) ?? []) {
      if (!dist.has(entry.neighbourId)) {
        dist.set(entry.neighbourId, d + 1);
        queue.push(entry.neighbourId);
      }
    }
  }
  return dist;
}

/*
 * Walk the BFS tree to recover the path (as piece-id list, anchor→dragged)
 * and the joints along it, in the same order.
 */
interface ChainPath {
  readonly pieceIds: string[];
  readonly joints: JointId[];
}

/*
 * BFS phase of findPath: build parent map from `fromId`. Returns parent map
 * and visited set.
 */
function bfsParents(
  fromId: string,
  toId: string,
  adj: Map<string, AdjEntry[]>,
): Map<string, { pieceId: string; joint: JointId }> {
  const parent = new Map<string, { pieceId: string; joint: JointId }>();
  const visited = new Set<string>([fromId]);
  const queue: string[] = [fromId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === toId) break;
    for (const entry of adj.get(current) ?? []) {
      if (!visited.has(entry.neighbourId)) {
        visited.add(entry.neighbourId);
        parent.set(entry.neighbourId, { pieceId: current, joint: entry.joint });
        queue.push(entry.neighbourId);
      }
    }
  }
  return parent;
}

/* Reconstruct path by tracing parent pointers from `toId` back to `fromId`. */
function reconstructPath(
  fromId: string,
  toId: string,
  parent: Map<string, { pieceId: string; joint: JointId }>,
): ChainPath {
  const pieceIds: string[] = [];
  const joints: JointId[] = [];
  let cursor: string | undefined = toId;
  while (cursor !== undefined && cursor !== fromId) {
    pieceIds.push(cursor);
    const p = parent.get(cursor);
    if (p === undefined) break;
    joints.push(p.joint);
    cursor = p.pieceId;
  }
  pieceIds.push(fromId);
  pieceIds.reverse();
  joints.reverse();
  return { pieceIds, joints };
}

/* Find the shortest path from `fromId` to `toId` through the joint graph. */
function findPath(
  fromId: string,
  toId: string,
  adj: Map<string, AdjEntry[]>,
): ChainPath | undefined {
  const parent = bfsParents(fromId, toId, adj);
  /* toId must appear in parent (unless from === to, a length-0 chain). */
  if (toId !== fromId && !parent.has(toId)) return undefined;
  return reconstructPath(fromId, toId, parent);
}

/* The set of piece ids reachable from `startId` over the joint graph (the
 * dragged piece's connected component). */
function componentOf(startId: string, adj: Map<string, AdjEntry[]>): Set<string> {
  return new Set(bfsDistances(startId, adj).keys());
}

/**
 * Whether the dragged piece's connected component has a genuine flex anchor.
 *
 * Flex relaxation pins one piece as a fixed root and bends the chain toward the
 * cursor about it. That only makes sense if the component actually has a fixed
 * reference: either a junction/branch piece (a natural anchor), OR an open chain
 * (a free end the relaxation can hold the far side of). A fully-closed loop with
 * no junction — every piece jointed on both sides, e.g. the 8-curve ring — has
 * NO such reference: any "anchor" is itself part of the moving cycle, so flexing
 * it tears the loop apart. For that case this returns false and the caller falls
 * through to plain piece behaviour (move / fast-yank detach) instead of flexing.
 *
 * Predicate: anchored ⇔ the component contains a junction piece other than the
 * dragged piece, OR the component has at least one open end (a member jointed on
 * fewer than two sides). A closed cycle has every member jointed on both sides
 * and no junction, so neither clause holds.
 */
export function hasFlexAnchor(pieces: ReadonlyArray<TrackPiece>, draggedPieceId: string): boolean {
  const joints = buildJoints(pieces);
  if (joints.length === 0) return false;
  const adj = buildAdj(pieces, joints);
  const component = componentOf(draggedPieceId, adj);

  for (const p of pieces) {
    if (p.type === 'junction' && p.id !== draggedPieceId && component.has(p.id)) return true;
  }

  /* An open end is a component member with fewer than two in-component joints. */
  for (const id of component) {
    const liveDegree = (adj.get(id) ?? []).filter((e) => component.has(e.neighbourId)).length;
    if (liveDegree < 2) return true;
  }

  return false;
}

/* ---------------------------------------------------------------------------
 * selectAnchor
 * --------------------------------------------------------------------------- */

/**
 * Choose a fixed anchor for flex relaxation given the piece being dragged.
 *
 * Strategy (in order):
 *   1. If the connected component contains a junction piece that is NOT the
 *      dragged piece, return it.
 *   2. Otherwise return the piece with the maximum BFS-joint-distance from
 *      the dragged piece (the "opposite" piece).
 */
export function selectAnchor(pieces: ReadonlyArray<TrackPiece>, draggedPieceId: string): string {
  const joints = buildJoints(pieces);
  const adj = buildAdj(pieces, joints);

  /* BFS distances from the dragged piece to find all connected members. */
  const distances = bfsDistances(draggedPieceId, adj);

  /* Prefer the FARTHEST junction in the component (not the first in iteration
     order): a junction adjacent to the dragged piece gives a degenerate 1-joint
     chain with almost no flex reach, whereas the farthest junction maximises the
     number of joints the bend distributes across. */
  let junctionId: string | undefined;
  let junctionDist = -1;
  for (const p of pieces) {
    if (p.type !== 'junction' || p.id === draggedPieceId) continue;
    const d = distances.get(p.id);
    if (d !== undefined && d > junctionDist) {
      junctionDist = d;
      junctionId = p.id;
    }
  }
  if (junctionId !== undefined) return junctionId;

  /* Fall back to the piece with maximum BFS distance. */
  let farthestId = draggedPieceId;
  let maxDist = -1;
  for (const [id, d] of distances) {
    if (id !== draggedPieceId && d > maxDist) {
      maxDist = d;
      farthestId = id;
    }
  }
  return farthestId;
}

/* ---------------------------------------------------------------------------
 * Damped-least-squares (Levenberg–Marquardt) relaxation core
 * --------------------------------------------------------------------------- */

/* A pose target: position always, heading optional (anti-parallel goal). */
interface PoseTarget {
  readonly x: number;
  readonly y: number;
  /* When set, the free endpoint heading is driven anti-parallel to this. */
  readonly outgoingAngleDeg?: number;
}

/* Everything the DLS loop needs that does not change between iterations. */
interface RelaxContext {
  readonly pieces: ReadonlyArray<TrackPiece>;
  readonly draggedPiece: TrackPiece;
  readonly anchorId: string;
  readonly freeEndpointIdx: number;
  /* The chain joints, anchor→dragged order; the δ vector aligns with this. */
  readonly joints: ReadonlyArray<JointId>;
}

/* Normalise an angle to (-180, 180] degrees. */
function normaliseDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/* Convert degrees to radians. */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/*
 * A joint's CURRENT bend away from its grid rest (degrees), read from the live
 * piece rotations. At grid rest two jointed pieces sit on the 45° grid, so their
 * relative rotation is a multiple of 45°; any baked-in flex shows up as a small
 * deviation from the nearest multiple. Because the per-joint budget is ≤ 5°
 * (well under 22.5°), rounding to the nearest 45° always recovers the grid rest.
 *
 * This is what lets the budget be ABSOLUTE: a slow drag bakes its bend into the
 * stored poses, so re-flexing a baked joint starts from a non-zero deviation;
 * clamping `deviation + δ` (not just δ) keeps the total within budget no matter
 * how many drag/release "stints" the operator does.
 */
function jointGridDeviation(pieces: ReadonlyArray<TrackPiece>, joint: JointId): number {
  const a = pieces.find((p) => p.id === joint.a.pieceId);
  const b = pieces.find((p) => p.id === joint.b.pieceId);
  if (a === undefined || b === undefined) return 0;
  const rel = b.rotationDeg - a.rotationDeg;
  return normaliseDeg(rel - Math.round(rel / 45) * 45);
}

/* Clamp `d` so that `cur + d` stays within ±FLEX_BUDGET_DEG (an ABSOLUTE budget
   measured from the joint's grid rest, `cur` being its current deviation). */
function clampToBudget(d: number, cur: number): number {
  return Math.max(-FLEX_BUDGET_DEG - cur, Math.min(FLEX_BUDGET_DEG - cur, d));
}

/* Build a FlexState from a δ vector aligned with `ctx.joints`. */
function flexFromDeltas(joints: ReadonlyArray<JointId>, deltas: ReadonlyArray<number>): FlexState {
  const map = new Map<string, JointFlex>();
  for (let i = 0; i < joints.length; i++) {
    const joint = joints[i];
    const deg = deltas[i];
    if (joint === undefined || deg === undefined) continue;
    map.set(jointKey(joint), { joint, deg, dx: 0, dy: 0 });
  }
  return map;
}

/* The dragged piece's free endpoint pose for a given δ vector. */
function freePoseFor(
  ctx: RelaxContext,
  deltas: ReadonlyArray<number>,
): { x: number; y: number; outgoingAngleDeg: number } | undefined {
  const poses = effectivePoses(ctx.pieces, flexFromDeltas(ctx.joints, deltas), ctx.anchorId);
  const pose = poses.get(ctx.draggedPiece.id);
  if (pose === undefined) return undefined;
  return getEndpointsAt(ctx.draggedPiece, pose)[ctx.freeEndpointIdx];
}

/*
 * The weighted error vector e = [Δx, Δy, (heading residual)·lever]. Heading
 * is included only when the target carries a heading goal; otherwise the third
 * component is zero (position-only follow). All components are in mm-equivalent
 * units so JᵀJ stays well-scaled.
 */
function errorVector(
  free: { x: number; y: number; outgoingAngleDeg: number },
  target: PoseTarget,
): [number, number, number] {
  const ex = target.x - free.x;
  const ey = target.y - free.y;
  if (target.outgoingAngleDeg === undefined) return [ex, ey, 0];
  /* Anti-parallel goal: free heading should oppose the target's exit. */
  const headingErrDeg = normaliseDeg(target.outgoingAngleDeg + 180 - free.outgoingAngleDeg);
  return [ex, ey, toRad(headingErrDeg) * HEADING_LEVER_MM];
}

/*
 * Finite-difference Jacobian J (3×N): column i is d(weighted error)/dδ_i, per
 * radian. Computed deterministically by perturbing each joint by FD_EPS_DEG and
 * re-running the forward kinematics — no analytic shortcut, no randomness.
 */
function computeJacobian(
  ctx: RelaxContext,
  deltas: ReadonlyArray<number>,
  baseError: ReadonlyArray<number>,
  target: PoseTarget,
): number[][] {
  const n = ctx.joints.length;
  const epsRad = toRad(FD_EPS_DEG);
  const rows: number[][] = [[], [], []];
  for (let i = 0; i < n; i++) {
    const perturbed = deltas.slice();
    perturbed[i] = (perturbed[i] ?? 0) + FD_EPS_DEG;
    const free = freePoseFor(ctx, perturbed);
    if (free === undefined) {
      for (let r = 0; r < 3; r++) (rows[r] ?? [])[i] = 0;
      continue;
    }
    const e = errorVector(free, target);
    /* d(error)/dδ = (e − baseError)/ε; error decreases as we approach, so the
     * Jacobian of the *residual* is the negative of that. We keep J as
     * d(free-pose-contribution); since e = target − free, dE/dδ = −d(free)/dδ,
     * and the gradient direction works out by using (baseError − e). */
    for (let r = 0; r < 3; r++) {
      (rows[r] ?? [])[i] = ((baseError[r] ?? 0) - (e[r] ?? 0)) / epsRad;
    }
  }
  return rows;
}

/* Cell access for an augmented matrix with the `?? 0` guard in one place. */
function cell(m: number[][], r: number, c: number): number {
  return (m[r] ?? [])[c] ?? 0;
}

/* Row index of the largest-magnitude entry in `col` at or below `col` (partial
 * pivoting). */
function pivotRowIndex(m: number[][], col: number, n: number): number {
  let pivot = col;
  for (let r = col + 1; r < n; r++) {
    if (Math.abs(cell(m, r, col)) > Math.abs(cell(m, pivot, col))) pivot = r;
  }
  return pivot;
}

/* Subtract the pivot row from every other row to zero out `col`. */
function eliminateColumn(m: number[][], col: number, n: number, pivotVal: number): void {
  const pivotRow = m[col] ?? [];
  for (let r = 0; r < n; r++) {
    if (r === col) continue;
    const row = m[r] ?? [];
    const factor = (row[col] ?? 0) / pivotVal;
    for (let c = col; c <= n; c++) row[c] = (row[c] ?? 0) - factor * (pivotRow[c] ?? 0);
  }
}

/* Solve the N×N linear system A x = b by Gauss–Jordan elimination with partial
 * pivoting. Deterministic; singular pivots are skipped (treated as zero). */
function solveLinearSystem(a: number[][], b: ReadonlyArray<number>): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    const pivot = pivotRowIndex(m, col, n);
    const tmp = m[col];
    m[col] = m[pivot] ?? [];
    if (tmp !== undefined) m[pivot] = tmp;
    const pivotVal = cell(m, col, col);
    if (Math.abs(pivotVal) < 1e-12) continue;
    eliminateColumn(m, col, n, pivotVal);
  }
  const x: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const diag = cell(m, i, i);
    x[i] = Math.abs(diag) < 1e-12 ? 0 : cell(m, i, n) / diag;
  }
  return x;
}

/* Clamp every component of a δ vector so each joint's TOTAL deviation from grid
   (`cur[i] + δ[i]`) stays within ±FLEX_BUDGET_DEG. `cur` is the per-joint baked
   deviation (zero for a fresh on-grid chain). */
function clampDeltas(deltas: ReadonlyArray<number>, cur: ReadonlyArray<number>): number[] {
  return deltas.map((d, i) => clampToBudget(d, cur[i] ?? 0));
}

/*
 * Build the LM normal equations (JᵀJ + λI)·step = Jᵀe and solve for the step
 * (in radians). `j` is the 3×N Jacobian, `error` the current 3-vector. A joint
 * marked `locked` is held at its bound: its Jacobian column is dropped (so the
 * remaining free joints absorb the motion) and its returned step is forced to
 * zero. This is clamped-least-squares — it lets a saturated joint redistribute
 * its demand onto unsaturated ones instead of the whole step stalling.
 */
/* Dot product of Jacobian columns i and k (a 3-row matrix). */
function jColDot(j: number[][], i: number, k: number): number {
  let v = 0;
  for (let r = 0; r < 3; r++) v += ((j[r] ?? [])[i] ?? 0) * ((j[r] ?? [])[k] ?? 0);
  return v;
}

/* Jacobian-transpose-times-error for column i (the i-th gradient component). */
function jColDotError(j: number[][], i: number, error: ReadonlyArray<number>): number {
  let g = 0;
  for (let r = 0; r < 3; r++) g += ((j[r] ?? [])[i] ?? 0) * (error[r] ?? 0);
  return g;
}

/* Build one row of JᵀJ + λI over the unlocked columns. */
function normalEquationRow(
  j: number[][],
  i: number,
  n: number,
  lambda: number,
  locked: ReadonlyArray<boolean>,
): number[] {
  const row = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    if (locked[k] === true) continue;
    row[k] = jColDot(j, i, k) + (i === k ? lambda : 0);
  }
  return row;
}

function dlsStep(
  j: number[][],
  error: ReadonlyArray<number>,
  lambda: number,
  locked: ReadonlyArray<boolean>,
): number[] {
  const n = (j[0] ?? []).length;
  const jtj: number[][] = [];
  const jte: number[] = [];
  for (let i = 0; i < n; i++) {
    if (locked[i] === true) {
      /* Pin a locked joint to zero step: identity row, zero gradient. */
      const row = new Array(n).fill(0);
      row[i] = 1;
      jtj[i] = row;
      jte[i] = 0;
      continue;
    }
    jtj[i] = normalEquationRow(j, i, n, lambda, locked);
    jte[i] = jColDotError(j, i, error);
  }
  return solveLinearSystem(jtj, jte);
}

/*
 * Clamped least-squares step: solve the LM system, then iteratively lock any
 * joint that the step drives past its ±budget bound (outward) and re-solve over
 * the remaining free joints. Returns the clamped trial δ vector. Bounded: each
 * lock removes one DOF, so at most N inner solves.
 */
function clampedStep(
  jacobian: number[][],
  error: ReadonlyArray<number>,
  lambda: number,
  deltas: ReadonlyArray<number>,
  cur: ReadonlyArray<number>,
): number[] {
  const n = deltas.length;
  const locked: boolean[] = new Array(n).fill(false);
  let trial = deltas.slice();
  for (let pass = 0; pass <= n; pass++) {
    const stepRad = dlsStep(jacobian, error, lambda, locked);
    trial = deltas.map((d, i) =>
      locked[i] === true ? clampToBudget(d, cur[i] ?? 0) : d + (180 * (stepRad[i] ?? 0)) / Math.PI,
    );
    let newlyLocked = false;
    for (let i = 0; i < n; i++) {
      if (locked[i] === true) continue;
      /* Lock when the joint's TOTAL deviation (baked + trial) leaves budget. */
      const total = (trial[i] ?? 0) + (cur[i] ?? 0);
      if (total > FLEX_BUDGET_DEG || total < -FLEX_BUDGET_DEG) {
        locked[i] = true;
        newlyLocked = true;
      }
    }
    if (!newlyLocked) break;
  }
  return clampDeltas(trial, cur);
}

/* Squared length of an error vector. */
function errorNormSq(e: ReadonlyArray<number>): number {
  return (e[0] ?? 0) ** 2 + (e[1] ?? 0) ** 2 + (e[2] ?? 0) ** 2;
}

/*
 * Iterated damped-least-squares relaxation. Drives the dragged piece's free
 * endpoint onto `target` (position, plus heading if the target carries one) by
 * repeatedly solving the LM normal equations and clamping each joint to budget.
 * λ adapts: it shrinks on an accepted (error-reducing) step and grows on a
 * rejected one, so the iteration is stable on long, near-closed chains where
 * undamped CCD diverges. Returns the final δ vector (always clamped). Pure.
 */
function relaxDls(ctx: RelaxContext, target: PoseTarget, seed?: ReadonlyArray<number>): number[] {
  /* Each joint's baked-in deviation from grid — the budget is measured from
     here, so re-flexing a baked chain cannot accumulate past ±FLEX_BUDGET_DEG. */
  const cur = ctx.joints.map((j) => jointGridDeviation(ctx.pieces, j));
  let deltas: number[] =
    seed !== undefined && seed.length === ctx.joints.length
      ? clampDeltas(seed, cur)
      : new Array(ctx.joints.length).fill(0);
  let lambda = 1.0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const free = freePoseFor(ctx, deltas);
    if (free === undefined) break;
    const error = errorVector(free, target);
    const currentNormSq = errorNormSq(error);
    if (currentNormSq < ERR_TOL * ERR_TOL) break;

    const jacobian = computeJacobian(ctx, deltas, error, target);
    const trial = clampedStep(jacobian, error, lambda, deltas, cur);

    const trialFree = freePoseFor(ctx, trial);
    if (trialFree === undefined) break;
    const trialNormSq = errorNormSq(errorVector(trialFree, target));

    if (trialNormSq < currentNormSq) {
      deltas = trial;
      lambda = Math.max(lambda * 0.5, 1e-6);
    } else {
      /* Reject: keep δ, raise damping toward gradient descent and retry. */
      lambda = Math.min(lambda * 4, 1e6);
    }
  }
  return clampDeltas(deltas, cur);
}

/* ---------------------------------------------------------------------------
 * Chain setup shared by both solvers
 * --------------------------------------------------------------------------- */

/* Resolve the anchor, joint chain, and dragged piece for a drag operation. */
function buildRelaxContext(
  pieces: ReadonlyArray<TrackPiece>,
  draggedPieceId: string,
  freeEndpointIdx: number,
): RelaxContext | undefined {
  const joints = buildJoints(pieces);
  if (joints.length === 0) return undefined;

  const adj = buildAdj(pieces, joints);
  const anchorId = selectAnchor(pieces, draggedPieceId);
  const path = findPath(anchorId, draggedPieceId, adj);
  if (path === undefined || path.joints.length === 0) return undefined;

  const draggedPiece = pieces.find((p) => p.id === draggedPieceId);
  if (draggedPiece === undefined) return undefined;

  return { pieces, draggedPiece, anchorId, freeEndpointIdx, joints: path.joints };
}

/* ---------------------------------------------------------------------------
 * solveFollow — position-only DLS relaxation
 * --------------------------------------------------------------------------- */

/**
 * Follow-cursor solver. Drives the dragged piece's free endpoint toward
 * `target` (position only) by damped-least-squares relaxation over the
 * anchor→dragged joint chain, every joint clamped to ±FLEX_BUDGET_DEG. Returns
 * a FlexState; pure and deterministic. The "free endpoint" is the dragged
 * piece's endpoint farthest from the anchor at rest (endpoint index 1 for a
 * two-ended piece, which is the cursor-side handle for the open chains the UI
 * drags).
 */
export function solveFollow(
  pieces: ReadonlyArray<TrackPiece>,
  draggedPieceId: string,
  target: { x: number; y: number },
  initialFlex?: FlexState,
): FlexState {
  const empty: FlexState = new Map<string, JointFlex>();

  /* A non-anchored component (a closed loop with no junction) has no fixed
     reference to flex about — bending it would tear the loop apart. Return an
     empty flex so the caller falls through to plain move / fast-yank-detach
     behaviour instead of flexing the ring. */
  if (!hasFlexAnchor(pieces, draggedPieceId)) return empty;

  const ctx = buildRelaxContext(pieces, draggedPieceId, freeEndpointIndex(pieces, draggedPieceId));
  if (ctx === undefined) return empty;

  /* Warm-start: seed the relaxation from the previous frame's solution so the
     DLS iterate doesn't restart cold every pointermove. Seeding the same joint
     configuration both removes the frame-to-frame jitter of independent cold
     solves and speeds convergence. Joints absent from the prior state seed 0. */
  const seed = initialFlex !== undefined ? seedFromFlex(ctx.joints, initialFlex) : undefined;
  const deltas = relaxDls(ctx, { x: target.x, y: target.y }, seed);
  return flexFromDeltas(ctx.joints, deltas);
}

/* Build a δ seed vector aligned with `joints` from a prior FlexState (the
 * inverse of flexFromDeltas). Joints not present in the state seed to 0. */
function seedFromFlex(joints: ReadonlyArray<JointId>, flex: FlexState): number[] {
  /* noUncheckedIndexedAccess: array elements are always defined here — joints
     is built from buildRelaxContext which only pushes real JointId values. */
  return joints.map((j) => (j === undefined ? 0 : (flex.get(jointKey(j))?.deg ?? 0)));
}

/**
 * The endpoint index of the dragged piece's free handle — the end the cursor
 * drags and that a closure snaps onto.
 *
 * Definition: the dragged piece's OPEN endpoint — the one not coincident with a
 * neighbour (not part of any joint). This is correct for BOTH an open chain (the
 * dangling outer end) AND a near-closed loop. The earlier "farthest from the
 * anchor by straight-line distance" heuristic is WRONG for a near-closed loop:
 * there the closing free end is physically NEAR the anchor (that is what makes
 * the loop near-closed), so straight-line distance picks the jointed end and the
 * solver drives the chain the wrong way. When there is no single open endpoint
 * (a middle piece jointed both sides), fall back to farthest-from-anchor.
 */
export function freeEndpointIndex(
  pieces: ReadonlyArray<TrackPiece>,
  draggedPieceId: string,
): number {
  const draggedPiece = pieces.find((p) => p.id === draggedPieceId);
  if (draggedPiece === undefined) return 0;

  /* Which of the dragged piece's endpoint indices are jointed to a neighbour. */
  const jointed = new Set<number>();
  for (const j of buildJoints(pieces)) {
    if (j.a.pieceId === draggedPieceId) jointed.add(j.a.endpointIdx);
    if (j.b.pieceId === draggedPieceId) jointed.add(j.b.endpointIdx);
  }

  const anchorId = selectAnchor(pieces, draggedPieceId);
  const poses = effectivePoses(pieces, new Map<string, JointFlex>(), anchorId);
  const pose = poses.get(draggedPieceId);
  const anchorPose = poses.get(anchorId);
  if (pose === undefined || anchorPose === undefined) return 0;
  const eps = getEndpointsAt(draggedPiece, pose);

  /* Exactly one open (unjointed) endpoint → that is the free handle. */
  const open = eps.map((_, i) => i).filter((i) => eps[i] !== undefined && !jointed.has(i));
  if (open.length === 1) return open[0] ?? 0;

  /* Ambiguous (a middle piece jointed both sides, or two open ends): fall back to
     the endpoint farthest from the anchor, reproducing the old open-chain rule. */
  return farthestEndpointIdx(eps, anchorPose);
}

/* Index of the endpoint farthest (straight-line) from `anchorPose`. */
function farthestEndpointIdx(
  eps: ReadonlyArray<{ x: number; y: number } | undefined>,
  anchorPose: { x: number; y: number },
): number {
  let bestIdx = 0;
  let bestDist = -1;
  for (let i = 0; i < eps.length; i++) {
    const ep = eps[i];
    if (ep === undefined) continue;
    const d = Math.hypot(ep.x - anchorPose.x, ep.y - anchorPose.y);
    if (d > bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/* ---------------------------------------------------------------------------
 * solveClose — loop-closure feasibility + solution
 * --------------------------------------------------------------------------- */

/** Result of a loop-closure solve attempt. */
export interface ClosureResult {
  readonly feasible: boolean;
  readonly flex: FlexState;
}

/*
 * Whether the free endpoint meets the closure target: position gap below
 * posToleranceMm AND heading anti-parallel within headingToleranceDeg.
 */
function meetsClosureTolerance(
  ep: { x: number; y: number; outgoingAngleDeg: number },
  target: { x: number; y: number; outgoingAngleDeg: number },
  posToleranceMm: number,
  headingToleranceDeg: number,
): boolean {
  const gap = Math.hypot(ep.x - target.x, ep.y - target.y);
  const headingDiff = Math.abs(normaliseDeg(ep.outgoingAngleDeg - (target.outgoingAngleDeg + 180)));
  return gap < posToleranceMm && headingDiff < headingToleranceDeg;
}

/**
 * Solve for a flex configuration that brings the dragged piece's free endpoint
 * onto `targetEndpoint` in BOTH position (< 1 mm) and heading (anti-parallel
 * within 1°), with every joint within ±FLEX_BUDGET_DEG.
 *
 * Uses damped-least-squares IK over the anchor→dragged joint chain, driving the
 * full 3-DOF pose error (Δx, Δy, heading) to zero. This converges on long,
 * near-closed chains (≥5 joints, including the 8-curve ring) where the previous
 * CCD diverged. `feasible` reflects whether the final residual is within
 * tolerance with all joints in budget; otherwise the best attempt is returned.
 * Pure, deterministic, no I/O.
 */
export function solveClose(
  pieces: ReadonlyArray<TrackPiece>,
  draggedPieceId: string,
  freeEndpointIdx: number,
  targetEndpoint: { x: number; y: number; outgoingAngleDeg: number },
): ClosureResult {
  const empty: FlexState = new Map<string, JointFlex>();
  const ctx = buildRelaxContext(pieces, draggedPieceId, freeEndpointIdx);
  if (ctx === undefined) return { feasible: false, flex: empty };

  const deltas = relaxDls(ctx, {
    x: targetEndpoint.x,
    y: targetEndpoint.y,
    outgoingAngleDeg: targetEndpoint.outgoingAngleDeg,
  });
  const flex = flexFromDeltas(ctx.joints, deltas);

  const finalEp = freePoseFor(ctx, deltas);
  if (finalEp === undefined) return { feasible: false, flex };

  const feasible = meetsClosureTolerance(finalEp, targetEndpoint, 1.0, 1.0);
  return { feasible, flex };
}
