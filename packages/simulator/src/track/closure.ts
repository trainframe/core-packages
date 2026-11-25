/**
 * Loop-closure detection and the closure-wave centreline, as pure functions over
 * placed track pieces. The toy table calls these while a dragged piece nears an
 * open end; nothing here touches React or the DOM.
 */

import type { ClosureResult } from './flex-solver.js';
import { freeEndpointIndex, solveClose } from './flex-solver.js';
import { type FlexState, applyFlex, effectivePoses } from './flex.js';
import { findLoops } from './loops.js';
import type { JointId } from './loops.js';
import {
  type CentreLinePath,
  type TrackPiece,
  asTrackPieces,
  getCentreLinePathAt,
  getEndpointsAt,
} from './pieces.js';
import { CONNECT_CAPTURE_MM, openEndpoints } from './placement.js';

/**
 * Try to close a loop: find the dragged piece's free endpoint in its current
 * effective pose, check if any open endpoint on another piece is within
 * CONNECT_CAPTURE_MM, and if so run solveClose. Returns the feasible result or
 * null. Pure — no React state, no refs.
 */
export function detectLoopClosure(
  trackPieces: ReadonlyArray<TrackPiece>,
  pieceId: string,
  flex: FlexState,
  anchorId: string,
): ClosureResult | null {
  const poses = effectivePoses(trackPieces, flex, anchorId);
  const draggedPiece = trackPieces.find((p) => p.id === pieceId);
  const anchorPose = poses.get(anchorId);
  const draggedPose = poses.get(pieceId);
  if (draggedPiece === undefined || anchorPose === undefined || draggedPose === undefined) {
    return null;
  }

  /* The dragged piece's OPEN endpoint (the one a closure snaps onto) — its
     pose under the current flex. Uses the same open-endpoint rule the solver
     uses so the closure target and the followed handle agree (the old
     farthest-from-anchor rule mispicked for a near-closed loop, where the free
     end is physically near the anchor). */
  const freeIdx = freeEndpointIndex(trackPieces, pieceId);
  const freeEp = getEndpointsAt(draggedPiece, draggedPose)[freeIdx];
  if (freeEp === undefined) return null;

  const open = openEndpoints(trackPieces, pieceId);
  let closureTarget: (typeof open)[number] | undefined;
  let closureTargetDist = CONNECT_CAPTURE_MM;
  for (const candidate of open) {
    const d = Math.hypot(candidate.x - freeEp.x, candidate.y - freeEp.y);
    if (d < closureTargetDist) {
      closureTargetDist = d;
      closureTarget = candidate;
    }
  }
  if (closureTarget === undefined) return null;

  const result = solveClose(trackPieces, pieceId, freeIdx, closureTarget);
  return result.feasible ? result : null;
}

/* Samples per half-path when building a loop's rail centreline for the wave. */
const WAVE_SAMPLES_PER_HALF = 8;

/* Returns the {entry, exit} endpoint indices for `pieceId` at position `i` in the loop. */
function entryExitEps(
  pieceId: string,
  i: number,
  joints: ReadonlyArray<JointId>,
  n: number,
): { entry: number; exit: number } | undefined {
  const exitJoint = joints[i];
  const entryJoint = joints[(i - 1 + n) % n];
  if (exitJoint === undefined || entryJoint === undefined) return undefined;
  const exit = exitJoint.a.pieceId === pieceId ? exitJoint.a.endpointIdx : exitJoint.b.endpointIdx;
  const entry =
    entryJoint.b.pieceId === pieceId ? entryJoint.b.endpointIdx : entryJoint.a.endpointIdx;
  return { entry, exit };
}

/* Sample a CentreLinePath from the far endpoint inward (skipping outermost to deduplicate joints). */
function sampleEntryHalf(
  path: CentreLinePath,
  halfCount: number,
  out: Array<{ x: number; y: number }>,
): void {
  for (let s = halfCount - 1; s >= 0; s--) {
    const p = path.at((s / halfCount) * path.length);
    out.push({ x: p.x, y: p.y });
  }
}

/* Sample a CentreLinePath outward from the centre (skipping centre to deduplicate within piece). */
function sampleExitHalf(
  path: CentreLinePath,
  halfCount: number,
  out: Array<{ x: number; y: number }>,
): void {
  for (let s = 1; s <= halfCount; s++) {
    const p = path.at((s / halfCount) * path.length);
    out.push({ x: p.x, y: p.y });
  }
}

/* Append the contiguous centreline points for one piece in the loop traversal. */
function sampleLoopPiece(
  piece: TrackPiece,
  pose: { x: number; y: number; rotationDeg: number },
  entryEp: number,
  exitEp: number,
  out: Array<{ x: number; y: number }>,
): void {
  const entryPath = getCentreLinePathAt(piece, pose, entryEp);
  if (entryPath !== undefined) sampleEntryHalf(entryPath, WAVE_SAMPLES_PER_HALF, out);
  const exitPath = getCentreLinePathAt(piece, pose, exitEp);
  if (exitPath !== undefined) sampleExitHalf(exitPath, WAVE_SAMPLES_PER_HALF, out);
}

/**
 * Compute the ordered rail-centreline world points for a loop that appears
 * after applying `closureFlex` to `restPieces` but was not present before.
 *
 * Returns the points for the FIRST newly-closed loop found (in practice
 * exactly one loop closes per drop), or null when no new loop is detected.
 *
 * The traversal uses the loop's joints to determine which endpoint of each
 * piece is the entry and which is the exit, so consecutive half-paths always
 * share their meeting endpoint and the polyline is continuous (no jumps at
 * joints). Duplicate vertices at joints are dropped (i < n on the entry half).
 *
 * Pure: no I/O, no side effects.
 */
export function newLoopCenterline(
  restPieces: ReadonlyArray<TrackPiece>,
  closureFlex: FlexState,
  draggedPieceId: string,
  anchorId?: string,
): ReadonlyArray<{ readonly x: number; readonly y: number }> | null {
  /* Bake under the SAME anchor `handleClosureCommit` commits with, so the wave
     centreline is computed over EXACTLY the closed geometry that gets stored.
     With a mismatched (default) anchor the forward kinematics can leave the
     closing joint a hair beyond SNAP_DISTANCE for some solved flexes, so
     `findLoops` misses the cycle and the wave silently never fires (seen on
     jerky closing drags). Passing the anchor keeps them in lock-step. */
  const afterEffective = applyFlex(restPieces, closureFlex, anchorId);
  const afterPieces = asTrackPieces(afterEffective);
  /* Find the cycle that contains the dragged piece in the committed effective
     geometry. We do NOT diff against rest-pose topology — clustering already
     decided connectivity there, so the before/after sets are identical for any
     closure whose gap is within SNAP_DISTANCE_MM. Fire on commit, not on diff. */
  const newLoop = findLoops(afterPieces).find((loop) => loop.pieceIds.includes(draggedPieceId));
  if (newLoop === undefined) return null;

  const poseMap = new Map<string, { x: number; y: number; rotationDeg: number }>();
  for (const ep of afterEffective) {
    poseMap.set(ep.id, { x: ep.position.x, y: ep.position.y, rotationDeg: ep.rotationDeg });
  }

  const { pieceIds, joints } = newLoop;
  const n = pieceIds.length;
  const points: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < n; i++) {
    const pieceId = pieceIds[i];
    if (pieceId === undefined) continue;
    const piece = afterPieces.find((p) => p.id === pieceId);
    const pose = poseMap.get(pieceId);
    if (piece === undefined || pose === undefined) continue;
    const eps = entryExitEps(pieceId, i, joints, n);
    if (eps === undefined) continue;
    sampleLoopPiece(piece, pose, eps.entry, eps.exit, points);
  }

  return points.length >= 2 ? points : null;
}
