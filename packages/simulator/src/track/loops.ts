/**
 * Joint graph and local-loop (cycle) detection over placed track pieces.
 *
 * Responsibility: given a set of placed TrackPiece objects (world-space), build
 * an adjacency graph (nodes = pieces, edges = joints) and find every closed loop
 * in it, excluding dangling spur branches.
 *
 * A joint connects two DIFFERENT pieces that share a cluster (endpoints within
 * SNAP_DISTANCE_MM, same layer). Joints are stable: the `a` endpoint is always
 * the lexicographically-smaller `pieceId:endpointIdx` string, so the same
 * physical connection always produces the same JointId regardless of piece
 * insertion order.
 *
 * Junction clusters (>2 endpoints): a junction piece contributes 3 endpoints to
 * its cluster. For every pair of distinct pieces in the cluster one joint is
 * emitted. This makes the junction node degree-3 in the piece graph (one edge
 * per branch) so spur peeling works naturally.
 *
 * Spur exclusion: iteratively remove degree-1 nodes (spurs / open chain ends)
 * until none remain. Any cycle left in the pruned graph is a true loop.
 */

import { clusterEndpoints, collectEndpoints } from './layout-from-pieces.js';
import type { TrackPiece } from './pieces.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JointId {
  readonly a: { readonly pieceId: string; readonly endpointIdx: number };
  readonly b: { readonly pieceId: string; readonly endpointIdx: number };
}

export interface Loop {
  readonly pieceIds: ReadonlyArray<string>;
  readonly joints: ReadonlyArray<JointId>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/* Stable sort key for one endpoint (used to order a and b in JointId). */
function endpointKey(pieceId: string, endpointIdx: number): string {
  return `${pieceId}:${endpointIdx}`;
}

/* Make a stable JointId: the lexicographically-smaller endpoint is always `a`. */
function makeJointId(
  pieceIdA: string,
  endpointIdxA: number,
  pieceIdB: string,
  endpointIdxB: number,
): JointId {
  const keyA = endpointKey(pieceIdA, endpointIdxA);
  const keyB = endpointKey(pieceIdB, endpointIdxB);
  if (keyA <= keyB) {
    return {
      a: { pieceId: pieceIdA, endpointIdx: endpointIdxA },
      b: { pieceId: pieceIdB, endpointIdx: endpointIdxB },
    };
  }
  return {
    a: { pieceId: pieceIdB, endpointIdx: endpointIdxB },
    b: { pieceId: pieceIdA, endpointIdx: endpointIdxA },
  };
}

/* Canonical string key for a JointId (used as Set/Map key). */
function jointKey(j: JointId): string {
  return `${endpointKey(j.a.pieceId, j.a.endpointIdx)}|${endpointKey(j.b.pieceId, j.b.endpointIdx)}`;
}

// ---------------------------------------------------------------------------
// buildJoints — internal helpers
// ---------------------------------------------------------------------------

interface ClusterMember {
  readonly pieceIdx: number;
  readonly endpointIdx: number;
}

/* Resolve a flat cluster (array of endpoint-ref indices) to (pieceIdx, endpointIdx) pairs. */
function membersOfCluster(
  cluster: ReadonlyArray<number>,
  allEndpoints: ReturnType<typeof collectEndpoints>,
): ClusterMember[] {
  const members: ClusterMember[] = [];
  for (const refIdx of cluster) {
    const ref = allEndpoints[refIdx];
    if (ref !== undefined) members.push({ pieceIdx: ref.pieceIdx, endpointIdx: ref.endpointIdx });
  }
  return members;
}

/* Emit deduplicated joints for one cluster into `joints` and `seenKeys`. */
function emitClusterJoints(
  members: ReadonlyArray<ClusterMember>,
  pieces: ReadonlyArray<TrackPiece>,
  joints: JointId[],
  seenKeys: Set<string>,
): void {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const ma = members[i];
      const mb = members[j];
      if (ma === undefined || mb === undefined || ma.pieceIdx === mb.pieceIdx) continue;
      const pieceA = pieces[ma.pieceIdx];
      const pieceB = pieces[mb.pieceIdx];
      if (pieceA === undefined || pieceB === undefined) continue;
      const jid = makeJointId(pieceA.id, ma.endpointIdx, pieceB.id, mb.endpointIdx);
      const key = jointKey(jid);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      joints.push(jid);
    }
  }
}

// ---------------------------------------------------------------------------
// buildJoints
// ---------------------------------------------------------------------------

/**
 * One JointId per cluster that contains endpoints of two or more DIFFERENT
 * pieces. Clusters with >2 endpoints (junctions, crossings) emit one joint per
 * connected pair of distinct pieces sharing the cluster — every pair, not just
 * trunk-to-branch — which makes the piece graph correctly degree-N for an N-way
 * junction.
 */
export function buildJoints(pieces: ReadonlyArray<TrackPiece>): ReadonlyArray<JointId> {
  const allEndpoints = collectEndpoints(pieces);
  const clusters = clusterEndpoints(allEndpoints);
  const seenKeys = new Set<string>();
  const joints: JointId[] = [];
  for (const cluster of clusters) {
    const members = membersOfCluster(cluster, allEndpoints);
    emitClusterJoints(members, pieces, joints, seenKeys);
  }
  return joints;
}

// ---------------------------------------------------------------------------
// findLoops — internal types and helpers
// ---------------------------------------------------------------------------

interface AdjEntry {
  readonly neighbour: string;
  readonly joint: JointId;
}

function buildAdjacency(
  pieceIds: ReadonlyArray<string>,
  joints: ReadonlyArray<JointId>,
): Map<string, AdjEntry[]> {
  const adj = new Map<string, AdjEntry[]>();
  for (const id of pieceIds) adj.set(id, []);
  for (const j of joints) {
    adj.get(j.a.pieceId)?.push({ neighbour: j.b.pieceId, joint: j });
    adj.get(j.b.pieceId)?.push({ neighbour: j.a.pieceId, joint: j });
  }
  return adj;
}

/* Remove `id` from the working degree map and decrement its live neighbours. */
function removeFromDegrees(
  id: string,
  removed: Set<string>,
  degree: Map<string, number>,
  adj: Map<string, AdjEntry[]>,
): void {
  removed.add(id);
  degree.set(id, 0);
  for (const entry of adj.get(id) ?? []) {
    if (!removed.has(entry.neighbour)) {
      const d = degree.get(entry.neighbour) ?? 0;
      degree.set(entry.neighbour, Math.max(0, d - 1));
    }
  }
}

/*
 * Iteratively peel degree-1 nodes (spurs / open chain ends).
 * Returns the set of piece IDs that survive (those in at least one cycle).
 */
function peelSpurs(adj: Map<string, AdjEntry[]>): Set<string> {
  const degree = new Map<string, number>();
  for (const [id, neighbours] of adj) degree.set(id, neighbours.length);
  const removed = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, deg] of degree) {
      if (removed.has(id)) continue;
      if (deg <= 1) {
        removeFromDegrees(id, removed, degree, adj);
        changed = true;
      }
    }
  }
  const surviving = new Set<string>();
  for (const [id] of adj) {
    if (!removed.has(id)) surviving.add(id);
  }
  return surviving;
}

/* Record a cycle if its sorted-ID fingerprint hasn't been seen before. */
function recordCycleIfNew(
  cyclePath: ReadonlyArray<string>,
  cycleJoints: ReadonlyArray<JointId>,
  cycles: Loop[],
  seenCycleKeys: Set<string>,
): void {
  const cycleKey = [...cyclePath].sort().join(',');
  if (seenCycleKeys.has(cycleKey)) return;
  seenCycleKeys.add(cycleKey);
  cycles.push({ pieceIds: cyclePath, joints: cycleJoints });
}

/* DFS state threaded through the recursive traversal. */
interface DfsState {
  readonly nodeSet: Set<string>;
  readonly adj: Map<string, AdjEntry[]>;
  readonly visited: Set<string>;
  readonly onStack: Set<string>;
  readonly path: string[];
  readonly pathJoints: JointId[];
  readonly cycles: Loop[];
  readonly seenCycleKeys: Set<string>;
}

function visitNeighbour(state: DfsState, entry: AdjEntry, current: string, parentId: string): void {
  const { neighbour, joint } = entry;
  if (!state.nodeSet.has(neighbour) || neighbour === parentId) return;
  if (!state.onStack.has(neighbour)) {
    state.pathJoints.push(joint);
    dfsNode(state, neighbour, current);
    state.pathJoints.pop();
  } else {
    const cycleStart = state.path.indexOf(neighbour);
    if (cycleStart === -1) return;
    const cyclePath = state.path.slice(cycleStart);
    const cycleJoints: JointId[] = [...state.pathJoints.slice(cycleStart), joint];
    recordCycleIfNew(cyclePath, cycleJoints, state.cycles, state.seenCycleKeys);
  }
}

function dfsNode(state: DfsState, current: string, parentId: string): void {
  state.visited.add(current);
  state.onStack.add(current);
  state.path.push(current);
  for (const entry of state.adj.get(current) ?? []) {
    visitNeighbour(state, entry, current, parentId);
  }
  state.onStack.delete(current);
  state.path.pop();
}

/*
 * Find all simple cycles in the subgraph induced by `nodeSet`.
 *
 * Deduplication: an undirected DFS discovers each ring twice (once per
 * traversal direction). We deduplicate by the sorted set of piece IDs.
 */
function findCycles(nodeSet: Set<string>, adj: Map<string, AdjEntry[]>): ReadonlyArray<Loop> {
  const state: DfsState = {
    nodeSet,
    adj,
    visited: new Set(),
    onStack: new Set(),
    path: [],
    pathJoints: [],
    cycles: [],
    seenCycleKeys: new Set(),
  };
  for (const startId of nodeSet) {
    /* Use '' as a sentinel "no parent" — no real piece id is the empty string. */
    if (!state.visited.has(startId)) dfsNode(state, startId, '');
  }
  return state.cycles;
}

// ---------------------------------------------------------------------------
// findLoops — public API
// ---------------------------------------------------------------------------

/**
 * Find all closed loops in the placed track. Spurs (degree-1 branches hanging
 * off junctions, open chain ends) are excluded before cycle detection so a
 * circle with an open junction branch still yields exactly one loop containing
 * only the ring pieces.
 *
 * Returns one Loop per distinct cycle; each Loop lists the piece IDs on the
 * ring and the joints that connect consecutive ring members.
 */
export function findLoops(pieces: ReadonlyArray<TrackPiece>): ReadonlyArray<Loop> {
  const joints = buildJoints(pieces);
  const pieceIds = pieces.map((p) => p.id);
  const adj = buildAdjacency(pieceIds, joints);
  const cycleNodes = peelSpurs(adj);
  if (cycleNodes.size === 0) return [];
  const prunedAdj = new Map<string, AdjEntry[]>();
  for (const id of cycleNodes) {
    prunedAdj.set(
      id,
      (adj.get(id) ?? []).filter((e) => cycleNodes.has(e.neighbour)),
    );
  }
  return findCycles(cycleNodes, prunedAdj);
}
