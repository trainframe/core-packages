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

  /* Prefer any junction piece that is not the dragged piece. */
  for (const p of pieces) {
    if (p.type === 'junction' && p.id !== draggedPieceId && distances.has(p.id)) {
      return p.id;
    }
  }

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

/* Clamp every component of a δ vector to ±FLEX_BUDGET_DEG. */
function clampDeltas(deltas: ReadonlyArray<number>): number[] {
  return deltas.map((d) => Math.max(-FLEX_BUDGET_DEG, Math.min(FLEX_BUDGET_DEG, d)));
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
): number[] {
  const n = deltas.length;
  const locked: boolean[] = new Array(n).fill(false);
  let trial = deltas.slice();
  for (let pass = 0; pass <= n; pass++) {
    const stepRad = dlsStep(jacobian, error, lambda, locked);
    trial = deltas.map((d, i) =>
      locked[i] === true
        ? Math.max(-FLEX_BUDGET_DEG, Math.min(FLEX_BUDGET_DEG, d))
        : d + (180 * (stepRad[i] ?? 0)) / Math.PI,
    );
    let newlyLocked = false;
    for (let i = 0; i < n; i++) {
      if (locked[i] === true) continue;
      const v = trial[i] ?? 0;
      if (v > FLEX_BUDGET_DEG || v < -FLEX_BUDGET_DEG) {
        locked[i] = true;
        newlyLocked = true;
      }
    }
    if (!newlyLocked) break;
  }
  return clampDeltas(trial);
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
function relaxDls(ctx: RelaxContext, target: PoseTarget): number[] {
  let deltas: number[] = new Array(ctx.joints.length).fill(0);
  let lambda = 1.0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const free = freePoseFor(ctx, deltas);
    if (free === undefined) break;
    const error = errorVector(free, target);
    const currentNormSq = errorNormSq(error);
    if (currentNormSq < ERR_TOL * ERR_TOL) break;

    const jacobian = computeJacobian(ctx, deltas, error, target);
    const trial = clampedStep(jacobian, error, lambda, deltas);

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
  return clampDeltas(deltas);
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
): FlexState {
  const empty: FlexState = new Map<string, JointFlex>();
  const ctx = buildRelaxContext(pieces, draggedPieceId, freeHandleIdx(pieces, draggedPieceId));
  if (ctx === undefined) return empty;

  const deltas = relaxDls(ctx, { x: target.x, y: target.y });
  return flexFromDeltas(ctx.joints, deltas);
}

/*
 * The endpoint index of the dragged piece's free handle: the endpoint farthest
 * from the anchor at rest. Mirrors the old `handleOf` selection so solveFollow
 * keeps targeting the cursor-side end. Falls back to index 0.
 */
function freeHandleIdx(pieces: ReadonlyArray<TrackPiece>, draggedPieceId: string): number {
  const draggedPiece = pieces.find((p) => p.id === draggedPieceId);
  if (draggedPiece === undefined) return 0;
  const anchorId = selectAnchor(pieces, draggedPieceId);
  const poses = effectivePoses(pieces, new Map<string, JointFlex>(), anchorId);
  const pose = poses.get(draggedPieceId);
  const anchorPose = poses.get(anchorId);
  if (pose === undefined || anchorPose === undefined) return 0;
  const eps = getEndpointsAt(draggedPiece, pose);
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
