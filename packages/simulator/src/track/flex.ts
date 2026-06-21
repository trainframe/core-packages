/**
 * Per-joint flex model: clamped deviation, flex state, and forward kinematics.
 *
 * A "joint" is a snapped connection between two track pieces. Real wooden track
 * has a small amount of physical give at each joint — the rail can rotate a
 * degree or two and slide a millimetre before the pieces visually separate.
 * This module models that give so the visualiser can show flex without breaking
 * the underlying logical graph.
 *
 * The coordinate convention and angle system match the rest of the track
 * module: angles are in degrees, clockwise from positive-x (east), consistent
 * with SVG transforms and pieces.ts.
 */

import { buildJoints, connectedComponents } from './loops.js';
import type { JointId } from './loops.js';
import { asEffectivePieces, getEndpointsAt } from './pieces.js';
import type { EffectivePiece, PiecePose, TrackPiece } from './pieces.js';

export type { PiecePose } from './pieces.js';
export type { JointId } from './loops.js';

/*
 * Maximum rotational deviation a joint may carry (degrees).
 *
 * Reach rationale: for an 8-joint ring at ~100 mm arm length, each joint
 * contributes roughly arm × budget_rad of free-end displacement. At ±5° the
 * combined reach is ≈ 8 × 100 × sin(5° × π/180) ≈ 70 mm — larger than
 * SNAP_DISTANCE_MM = 30 mm, so flex can close moderate gaps (30–60 mm) that
 * the rigid auto-snap pre-empts only below 30 mm. The previous ±2° gave only
 * ~27 mm reach, smaller than the snap distance, making closure unreachable.
 * The new budget stays well below CONNECT_CAPTURE_MM = 60 mm at the tight
 * end; typical closure targets live in the 30–60 mm band.
 */
export const FLEX_BUDGET_DEG = 5;

/* Maximum translational deviation a joint may carry (mm). */
export const FLEX_GIVE_MM = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The δ for one joint. All fields are pre-clamped; construct via `clampFlex`
 * so invariants are enforced at a single boundary.
 */
export interface JointFlex {
  readonly joint: JointId;
  readonly deg: number;
  readonly dx: number;
  readonly dy: number;
}

/**
 * Flex state for a whole layout. The key is `jointKey(jid)`. Joints absent
 * from the map carry zero deviation (rest pose).
 */
export type FlexState = ReadonlyMap<string, JointFlex>;

// ---------------------------------------------------------------------------
// jointKey
// ---------------------------------------------------------------------------

/**
 * A stable string key for a JointId, suitable for use as a Map/Set key.
 * Derived from the canonical a/b ordering that buildJoints already enforces,
 * so the same physical connection always maps to the same key.
 */
export function jointKey(j: JointId): string {
  return `${j.a.pieceId}:${j.a.endpointIdx}|${j.b.pieceId}:${j.b.endpointIdx}`;
}

// ---------------------------------------------------------------------------
// clampFlex
// ---------------------------------------------------------------------------

/**
 * Clamp raw flex values to the physical budget:
 * - `deg` is clamped to ±FLEX_BUDGET_DEG
 * - `(dx, dy)` is clamped so its magnitude does not exceed FLEX_GIVE_MM
 *   (the direction is preserved; only the magnitude is reduced)
 */
export function clampFlex(
  deg: number,
  dx: number,
  dy: number,
): { deg: number; dx: number; dy: number } {
  const clampedDeg = Math.max(-FLEX_BUDGET_DEG, Math.min(FLEX_BUDGET_DEG, deg));
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag <= FLEX_GIVE_MM || mag === 0) {
    return { deg: clampedDeg, dx, dy };
  }
  const scale = FLEX_GIVE_MM / mag;
  return { deg: clampedDeg, dx: dx * scale, dy: dy * scale };
}

// ---------------------------------------------------------------------------
// effectivePoses — forward kinematics
// ---------------------------------------------------------------------------

/* Convert degrees to radians. */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/* Rotate a vector (vx, vy) by `angleDeg` degrees clockwise (SVG convention). */
function rotateVec(vx: number, vy: number, angleDeg: number): { x: number; y: number } {
  const r = toRad(angleDeg);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: vx * cos - vy * sin, y: vx * sin + vy * cos };
}

/*
 * Adjacency entry for the spanning-tree walk: the neighbouring piece ID, the
 * joint connecting them, and which side of the joint the neighbour is on (so
 * we know which endpoint index to query for the joint point position).
 */
interface AdjEntry {
  readonly neighbourId: string;
  readonly joint: JointId;
  /* Endpoint index ON THE PARENT's piece that touches this joint. */
  readonly parentEndpointIdx: number;
  /* Endpoint index ON THE CHILD's piece that touches this joint. */
  readonly childEndpointIdx: number;
}

/* Build an adjacency list keyed by piece ID from the full joint array. */
function buildAdj(
  pieces: ReadonlyArray<TrackPiece>,
  joints: ReadonlyArray<JointId>,
): Map<string, AdjEntry[]> {
  const adj = new Map<string, AdjEntry[]>();
  for (const p of pieces) adj.set(p.id, []);
  for (const j of joints) {
    adj.get(j.a.pieceId)?.push({
      neighbourId: j.b.pieceId,
      joint: j,
      parentEndpointIdx: j.a.endpointIdx,
      childEndpointIdx: j.b.endpointIdx,
    });
    adj.get(j.b.pieceId)?.push({
      neighbourId: j.a.pieceId,
      joint: j,
      parentEndpointIdx: j.b.endpointIdx,
      childEndpointIdx: j.a.endpointIdx,
    });
  }
  return adj;
}

/* BFS queue entry: piece ID + the piece's rest rotation (needed to compute the
 * cumulative rotation delta passed from parent to child). */
interface QueueEntry {
  readonly parentId: string;
  readonly parentRestRot: number;
}

/*
 * Compute the child's effective pose for one joint edge.
 *
 * At each joint (parent → child), the child's effective pose is:
 *
 *   childEffRot = childRestRot + (parentEffRot − parentRestRot) + jointDeg
 *   childEffPos = jointEffPos
 *                 + rotate(childRestPos − jointRestPos,
 *                          parentEffRot − parentRestRot + jointDeg)
 *                 + (dx, dy)
 *
 * The `(parentEffRot − parentRestRot)` term propagates cumulative rotation
 * accumulated from the anchor; `jointDeg` is the local δ at this joint.
 * The position formula rotates the rest-space vector (joint→child) by the
 * total angle then translates by the give offset.
 */
function childPoseForEdge(
  parentPiece: TrackPiece,
  parentPose: PiecePose,
  parentRestRot: number,
  childPiece: TrackPiece,
  entry: AdjEntry,
  flex: FlexState,
  restPoseOf: (p: TrackPiece) => PiecePose,
): PiecePose | undefined {
  /* Joint point in world space = parent's effective endpoint at the joint. */
  const jointEffEp = getEndpointsAt(parentPiece, parentPose)[entry.parentEndpointIdx];
  if (jointEffEp === undefined) return undefined;

  /* Joint point at rest = parent's rest endpoint at the joint. */
  const parentRestEps = getEndpointsAt(parentPiece, restPoseOf(parentPiece));
  const jointRestEp = parentRestEps[entry.parentEndpointIdx];
  if (jointRestEp === undefined) return undefined;

  /* Child's rest pose and flex δ for this joint. */
  const childRest = restPoseOf(childPiece);
  const jflex = flex.get(jointKey(entry.joint));
  const jointDeg = jflex?.deg ?? 0;
  const dx = jflex?.dx ?? 0;
  const dy = jflex?.dy ?? 0;

  /* Total rotation to apply to the child-subtree (inherited + this joint). */
  const totalDeltaRot = parentPose.rotationDeg - parentRestRot + jointDeg;

  /* Rotate the rest-space vector (joint→child) and place at effective joint. */
  const rotated = rotateVec(
    childRest.x - jointRestEp.x,
    childRest.y - jointRestEp.y,
    totalDeltaRot,
  );
  return {
    x: jointEffEp.x + rotated.x + dx,
    y: jointEffEp.y + rotated.y + dy,
    rotationDeg: childRest.rotationDeg + totalDeltaRot,
  };
}

/* Process one adjacency entry during the BFS walk, updating result and queue. */
function processEdge(
  entry: AdjEntry,
  parentPiece: TrackPiece,
  parentPose: PiecePose,
  parentRestRot: number,
  pieceById: ReadonlyMap<string, TrackPiece>,
  flex: FlexState,
  restPoseOf: (p: TrackPiece) => PiecePose,
  visited: Set<string>,
  result: Map<string, PiecePose>,
  queue: QueueEntry[],
): void {
  if (visited.has(entry.neighbourId)) return;
  visited.add(entry.neighbourId);

  const childPiece = pieceById.get(entry.neighbourId);
  if (childPiece === undefined) return;

  const childPose = childPoseForEdge(
    parentPiece,
    parentPose,
    parentRestRot,
    childPiece,
    entry,
    flex,
    restPoseOf,
  );
  if (childPose === undefined) return;

  result.set(entry.neighbourId, childPose);
  queue.push({ parentId: entry.neighbourId, parentRestRot: childPiece.rotationDeg });
}

/*
 * BFS spanning-tree walk from the anchor. Delegates per-edge work to
 * `processEdge` and pose computation to `childPoseForEdge`. When the entire
 * chain has zero flex, all deltas cancel and every piece returns its rest pose.
 */
function walkTree(
  anchorId: string,
  pieceById: ReadonlyMap<string, TrackPiece>,
  adj: Map<string, AdjEntry[]>,
  flex: FlexState,
  restPoseOf: (p: TrackPiece) => PiecePose,
): Map<string, PiecePose> {
  const result = new Map<string, PiecePose>();
  const visited = new Set<string>();

  const anchor = pieceById.get(anchorId);
  if (anchor !== undefined) {
    result.set(anchorId, restPoseOf(anchor));
    visited.add(anchorId);
  }

  const queue: QueueEntry[] = [{ parentId: anchorId, parentRestRot: anchor?.rotationDeg ?? 0 }];

  while (queue.length > 0) {
    const head = queue.shift();
    if (head === undefined) break;
    const { parentId, parentRestRot } = head;

    const parentPose = result.get(parentId);
    if (parentPose === undefined) continue;
    const parentPiece = pieceById.get(parentId);
    if (parentPiece === undefined) continue;

    for (const entry of adj.get(parentId) ?? []) {
      processEdge(
        entry,
        parentPiece,
        parentPose,
        parentRestRot,
        pieceById,
        flex,
        restPoseOf,
        visited,
        result,
        queue,
      );
    }
  }

  return result;
}

/**
 * Compute the effective world-space pose for every piece, applying the flex
 * deviations in `flex` along the joint spanning tree rooted at `anchorPieceId`.
 *
 * The anchor stays at its rest pose (its `position` and `rotationDeg` fields).
 * Every other piece's pose is derived by walking the spanning tree from the
 * anchor: at each joint, the child subtree is rotated about the joint point by
 * `deg` and translated by `(dx, dy)`.
 *
 * Pure: no I/O, no mutation of inputs.
 */
export function effectivePoses(
  pieces: ReadonlyArray<TrackPiece>,
  flex: FlexState,
  anchorPieceId: string,
): ReadonlyMap<string, PiecePose> {
  /* Index pieces by ID for O(1) lookup during the walk. */
  const pieceById = new Map<string, TrackPiece>();
  for (const p of pieces) pieceById.set(p.id, p);

  const joints = buildJoints(pieces);
  const adj = buildAdj(pieces, joints);

  /* Extract rest pose from a piece's stored (quantized) fields. */
  const restPoseOf = (p: TrackPiece): PiecePose => ({
    x: p.position.x,
    y: p.position.y,
    rotationDeg: p.rotationDeg,
  });

  return walkTree(anchorPieceId, pieceById, adj, flex, restPoseOf);
}

/**
 * Apply `flex` to `pieces`, returning effective-pose pieces whose `position`
 * and `rotationDeg` reflect any joint deviations in `flex`. With an empty
 * `FlexState` the result is structurally identical to the input (every piece
 * returns its rest pose), so rendering/placing through `applyFlex` is a no-op
 * when nothing is flexed.
 *
 * One anchor is chosen per connected component. By default it is the first
 * piece in iteration order; pass `anchorOverride` to pin a specific piece (the
 * component CONTAINING it is rooted there, others keep the default). The anchor
 * stays at its rest pose; all other pieces in the component are walked outward
 * from it via {@link effectivePoses}. Forward kinematics is relative, so the
 * component's *shape* is anchor-independent — but the *absolute* placement is
 * not, so a live drag must render under the SAME anchor the solver used, else
 * the dragged piece renders rigidly offset from the cursor and appears to jump
 * on release. The toybox threads the solver's anchor through here for that
 * reason; a stale/foreign override simply falls back to the default per
 * component.
 *
 * This is THE producer of effective (branded) geometry — every spatial consumer
 * (placement, snapping, closure, compile, render) reads its output, never a raw
 * rest-pose array. The brand (see {@link EffectivePiece}) makes that structural.
 *
 * Pure: no I/O, no mutation of inputs.
 */
export function applyFlex(
  pieces: ReadonlyArray<TrackPiece>,
  flex: FlexState,
  anchorOverride?: string,
): ReadonlyArray<EffectivePiece> {
  if (pieces.length === 0) return asEffectivePieces([]);

  /* Fast path: empty flex means every piece returns its rest pose unchanged. */
  if (flex.size === 0) {
    return asEffectivePieces(pieces.map((p) => ({ ...p, rotationDeg: p.rotationDeg })));
  }

  /* Check which joints the flex map actually references. */
  const joints = buildJoints(pieces);
  const activeJoints = joints.filter((j) => flex.has(jointKey(j)));
  if (activeJoints.length === 0) {
    return asEffectivePieces(pieces.map((p) => ({ ...p, rotationDeg: p.rotationDeg })));
  }

  /* Per-component forward kinematics. */
  const components = connectedComponents(pieces);
  const pieceById = new Map<string, TrackPiece>();
  for (const p of pieces) pieceById.set(p.id, p);

  /* Build a pose map covering all components. */
  const poses = new Map<string, { x: number; y: number; rotationDeg: number }>();
  for (const component of components) {
    /* Root the drag's component at the solver's anchor when it falls in this
       component; otherwise the first piece (stable: insertion order). */
    const anchorId =
      anchorOverride !== undefined && component.has(anchorOverride)
        ? anchorOverride
        : [...component][0];
    if (anchorId === undefined) continue;
    const componentPieces = [...component]
      .map((id) => pieceById.get(id))
      .filter((p): p is TrackPiece => p !== undefined);
    const effectiveMap = effectivePoses(componentPieces, flex, anchorId);
    for (const [id, pose] of effectiveMap) {
      poses.set(id, pose);
    }
  }

  return asEffectivePieces(
    pieces.map((p) => {
      const pose = poses.get(p.id);
      if (pose === undefined) return { ...p, rotationDeg: p.rotationDeg };
      return { ...p, position: { x: pose.x, y: pose.y }, rotationDeg: pose.rotationDeg };
    }),
  );
}
