/**
 * Flex solver: anchor selection, CCD-style follow-cursor relaxation, and
 * loop-closure feasibility check.
 *
 * The solver operates on the joint graph built by `buildJoints`. It treats
 * each joint as a rotational degree of freedom bounded to ±FLEX_BUDGET_DEG.
 * Given a dragged piece and a cursor target, it walks the chain from the
 * anchor toward the dragged piece, rotating each joint to bring the dragged
 * piece's handle toward the target. Pure, deterministic, no I/O.
 */

import {
  FLEX_BUDGET_DEG,
  type FlexState,
  type JointFlex,
  clampFlex,
  effectivePoses,
  jointKey,
} from './flex.js';
import type { JointId } from './loops.js';
import { buildJoints } from './loops.js';
import { getEndpointsAt } from './pieces.js';
import type { TrackPiece } from './pieces.js';

/* Maximum CCD iterations before we stop (keeps runtime bounded). */
const MAX_ITERATIONS = 16;

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
 * solveFollow — CCD relaxation
 * --------------------------------------------------------------------------- */

/*
 * Derive the "handle" (the endpoint of the dragged piece farthest from the
 * anchor) from the current effective poses.
 */
function handleOf(
  draggedPiece: TrackPiece,
  poses: ReadonlyMap<string, { x: number; y: number; rotationDeg: number }>,
  anchorId: string,
): { x: number; y: number } | undefined {
  const pose = poses.get(draggedPiece.id);
  if (pose === undefined) return undefined;
  const eps = getEndpointsAt(draggedPiece, pose);
  if (eps.length === 0) return pose;
  const anchorPose = poses.get(anchorId);
  if (anchorPose === undefined || eps.length === 1) return eps[0] ?? pose;
  let best = eps[0];
  let bestDist = -1;
  for (const ep of eps) {
    const d = Math.hypot(ep.x - anchorPose.x, ep.y - anchorPose.y);
    if (d > bestDist) {
      bestDist = d;
      best = ep;
    }
  }
  return best ?? pose;
}

/* Signed angle (degrees) to rotate `handle` toward `target` about `pivot`. */
function angleToward(
  pivot: { x: number; y: number },
  handle: { x: number; y: number },
  target: { x: number; y: number },
): number {
  const hx = handle.x - pivot.x;
  const hy = handle.y - pivot.y;
  const tx = target.x - pivot.x;
  const ty = target.y - pivot.y;
  if (Math.hypot(hx, hy) < 1e-9 || Math.hypot(tx, ty) < 1e-9) return 0;
  return (Math.atan2(hx * ty - hy * tx, hx * tx + hy * ty) * 180) / Math.PI;
}

/*
 * Compute the updated rotation δ for `joint` to rotate the dragged handle
 * toward `target`. `pivotPiece` is the anchor-side piece at this joint;
 * `pivotPose` is its current effective pose. Returns the new clamped deg.
 */
function updatedJointDeg(
  joint: JointId,
  pivotPieceId: string,
  pivotPose: { x: number; y: number; rotationDeg: number },
  pivotPiece: TrackPiece,
  handle: { x: number; y: number },
  target: { x: number; y: number },
  currentDeg: number,
): number {
  const idx = joint.a.pieceId === pivotPieceId ? joint.a.endpointIdx : joint.b.endpointIdx;
  const jointPt = getEndpointsAt(pivotPiece, pivotPose)[idx];
  if (jointPt === undefined) return currentDeg;
  const delta = angleToward(jointPt, handle, target);
  const proposed = currentDeg + delta;
  return Math.max(-FLEX_BUDGET_DEG, Math.min(FLEX_BUDGET_DEG, proposed));
}

/*
 * One CCD pass over the joint chain: update each joint in sequence to move
 * the dragged piece's handle toward `target`. Mutates `flexMap` in place.
 */
function ccdPass(
  path: ChainPath,
  pieceById: ReadonlyMap<string, TrackPiece>,
  pieces: ReadonlyArray<TrackPiece>,
  draggedPiece: TrackPiece,
  anchorId: string,
  target: { x: number; y: number },
  flexMap: Map<string, JointFlex>,
): void {
  for (let ji = 0; ji < path.joints.length; ji++) {
    const joint = path.joints[ji];
    const pivotId = path.pieceIds[ji];
    if (joint === undefined || pivotId === undefined) continue;
    const pivotPiece = pieceById.get(pivotId);
    if (pivotPiece === undefined) continue;

    /* Re-evaluate after each joint update for classic CCD behaviour. */
    const poses = effectivePoses(pieces, flexMap as FlexState, anchorId);
    const pivotPose = poses.get(pivotId);
    if (pivotPose === undefined) continue;
    const handle = handleOf(draggedPiece, poses, anchorId);
    if (handle === undefined) continue;

    const key = jointKey(joint);
    const currentDeg = flexMap.get(key)?.deg ?? 0;
    const newDeg = updatedJointDeg(
      joint,
      pivotId,
      pivotPose,
      pivotPiece,
      handle,
      target,
      currentDeg,
    );
    const clamped = clampFlex(newDeg, 0, 0);
    flexMap.set(key, { joint, deg: clamped.deg, dx: 0, dy: 0 });
  }
}

/**
 * Iterative CCD-style follow-cursor solver.
 *
 * Walks the chain of joints from the anchor toward the dragged piece. On each
 * pass, rotates each joint (within ±FLEX_BUDGET_DEG) to bring the dragged
 * piece's free handle toward `target`. Repeats up to MAX_ITERATIONS times or
 * until the handle is close enough (< 0.1 mm). Returns a FlexState; pure.
 */
export function solveFollow(
  pieces: ReadonlyArray<TrackPiece>,
  draggedPieceId: string,
  target: { x: number; y: number },
): FlexState {
  const joints = buildJoints(pieces);
  if (joints.length === 0) return new Map<string, JointFlex>();

  const adj = buildAdj(pieces, joints);
  const anchorId = selectAnchor(pieces, draggedPieceId);
  const path = findPath(anchorId, draggedPieceId, adj);
  if (path === undefined || path.joints.length === 0) return new Map<string, JointFlex>();

  const pieceById = new Map<string, TrackPiece>();
  for (const p of pieces) pieceById.set(p.id, p);
  const draggedPiece = pieceById.get(draggedPieceId);
  if (draggedPiece === undefined) return new Map<string, JointFlex>();

  const flexMap = new Map<string, JointFlex>();

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const poses = effectivePoses(pieces, flexMap as FlexState, anchorId);
    const handle = handleOf(draggedPiece, poses, anchorId);
    if (handle === undefined) break;
    if (Math.hypot(handle.x - target.x, handle.y - target.y) < 0.1) break;
    ccdPass(path, pieceById, pieces, draggedPiece, anchorId, target, flexMap);
  }

  return flexMap as FlexState;
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
 * Normalise an angle to the range (-180, 180] degrees.
 * Used to compute the smallest signed difference between two headings.
 */
function normaliseDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/*
 * The endpoint at `freeEndpointIdx` of the dragged piece in its current effective pose.
 * Returns undefined if the pose or endpoint is missing.
 */
function freeEndpointOf(
  draggedPiece: TrackPiece,
  poses: ReadonlyMap<string, { x: number; y: number; rotationDeg: number }>,
  freeEndpointIdx: number,
): { x: number; y: number; outgoingAngleDeg: number } | undefined {
  const pose = poses.get(draggedPiece.id);
  if (pose === undefined) return undefined;
  return getEndpointsAt(draggedPiece, pose)[freeEndpointIdx];
}

/*
 * Check whether the dragged piece's free endpoint meets the target pose:
 * - position gap < posToleranceMm
 * - heading difference (anti-parallel) < headingToleranceDeg
 */
function meetsClosureTolerance(
  ep: { x: number; y: number; outgoingAngleDeg: number },
  target: { x: number; y: number; outgoingAngleDeg: number },
  posToleranceMm: number,
  headingToleranceDeg: number,
): boolean {
  const gap = Math.hypot(ep.x - target.x, ep.y - target.y);
  /* Anti-parallel: the free endpoint exits opposite to the target's exit direction. */
  const headingDiff = Math.abs(normaliseDeg(ep.outgoingAngleDeg - (target.outgoingAngleDeg + 180)));
  return gap < posToleranceMm && headingDiff < headingToleranceDeg;
}

/**
 * Solve for a flex configuration that brings the dragged piece's free endpoint
 * onto `targetEndpoint` in BOTH position (≤ 1 mm) and heading (anti-parallel
 * within 1°), within every joint's ±FLEX_BUDGET_DEG budget.
 *
 * Reuses the CCD follow-cursor relaxation with the target position, then checks
 * the final heading residual to determine feasibility. If the gap or heading
 * error after relaxation exceeds the tolerance, `feasible` is false and the
 * returned flex is the best attempt. Pure, deterministic, no I/O.
 */
export function solveClose(
  pieces: ReadonlyArray<TrackPiece>,
  draggedPieceId: string,
  freeEndpointIdx: number,
  targetEndpoint: { x: number; y: number; outgoingAngleDeg: number },
): ClosureResult {
  const joints = buildJoints(pieces);
  const empty: FlexState = new Map<string, JointFlex>();
  if (joints.length === 0) return { feasible: false, flex: empty };

  const adj = buildAdj(pieces, joints);
  const anchorId = selectAnchor(pieces, draggedPieceId);
  const path = findPath(anchorId, draggedPieceId, adj);
  if (path === undefined || path.joints.length === 0) return { feasible: false, flex: empty };

  const pieceById = new Map<string, TrackPiece>();
  for (const p of pieces) pieceById.set(p.id, p);
  const draggedPiece = pieceById.get(draggedPieceId);
  if (draggedPiece === undefined) return { feasible: false, flex: empty };

  const target = { x: targetEndpoint.x, y: targetEndpoint.y };
  const flexMap = new Map<string, JointFlex>();

  /* CCD iterations toward the target position. */
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const poses = effectivePoses(pieces, flexMap as FlexState, anchorId);
    const ep = freeEndpointOf(draggedPiece, poses, freeEndpointIdx);
    if (ep === undefined) break;
    if (Math.hypot(ep.x - target.x, ep.y - target.y) < 0.1) break;
    ccdPass(path, pieceById, pieces, draggedPiece, anchorId, target, flexMap);
  }

  const flex = flexMap as FlexState;

  /* Final feasibility check: position + heading must both be within tolerance. */
  const finalPoses = effectivePoses(pieces, flex, anchorId);
  const finalEp = freeEndpointOf(draggedPiece, finalPoses, freeEndpointIdx);
  if (finalEp === undefined) return { feasible: false, flex };

  const feasible = meetsClosureTolerance(finalEp, targetEndpoint, 1.0, 1.0);
  return { feasible, flex };
}
