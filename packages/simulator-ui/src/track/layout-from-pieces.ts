import type { Layout, LayoutEdge, LayoutJunction, LayoutMarker } from '@trainframe/protocol';
import { getEndpoints } from './pieces.js';
import type { TrackPiece } from './pieces.js';

/**
 * Snap distance in mm. Two endpoints within this distance are treated as
 * the same physical connection point and mapped to a shared marker.
 */
export const SNAP_DISTANCE_MM = 30;

interface EndpointRef {
  readonly pieceIdx: number;
  readonly endpointIdx: number;
  readonly x: number;
  readonly y: number;
}

// ---------------------------------------------------------------------------
// Marker-kind precedence (higher number wins on cluster collision)
// ---------------------------------------------------------------------------

const KIND_PRECEDENCE: Record<LayoutMarker['kind'], number> = {
  junction: 4,
  station_stop: 3,
  terminus: 2,
  block_boundary: 1,
  yard_entry: 1,
  unspecified: 0,
};

// ---------------------------------------------------------------------------
// Step 1 — collect endpoints
// ---------------------------------------------------------------------------

function collectEndpoints(pieces: ReadonlyArray<TrackPiece>): EndpointRef[] {
  const refs: EndpointRef[] = [];
  for (let pi = 0; pi < pieces.length; pi++) {
    const piece = pieces[pi];
    if (piece === undefined) continue;
    const eps = getEndpoints(piece);
    for (let ei = 0; ei < eps.length; ei++) {
      const ep = eps[ei];
      if (ep === undefined) continue;
      refs.push({ pieceIdx: pi, endpointIdx: ei, x: ep.x, y: ep.y });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Step 2 — greedy clustering
// ---------------------------------------------------------------------------

interface ClusterResult {
  /** clusters[c] = indices into allEndpoints that belong to cluster c */
  readonly clusters: ReadonlyArray<readonly number[]>;
  /** pieceEndpointKey → cluster index */
  readonly pieceEpCluster: ReadonlyMap<string, number>;
}

/** Find the index of the first cluster whose representative endpoint is within snap distance. */
function findNearbyCluster(
  ep: EndpointRef,
  clusters: ReadonlyArray<readonly number[]>,
  allEndpoints: ReadonlyArray<EndpointRef>,
): number {
  for (let c = 0; c < clusters.length; c++) {
    const rep = clusters[c]?.[0];
    if (rep === undefined) continue;
    const repEp = allEndpoints[rep];
    if (repEp === undefined) continue;
    const dx = ep.x - repEp.x;
    const dy = ep.y - repEp.y;
    if (Math.sqrt(dx * dx + dy * dy) <= SNAP_DISTANCE_MM) return c;
  }
  return -1;
}

/** Build the pieceEndpointKey→cluster map from the clustering results. */
function buildPieceEpMap(
  allEndpoints: ReadonlyArray<EndpointRef>,
  clusterOf: ReadonlyArray<number>,
): Map<string, number> {
  const pieceEpCluster = new Map<string, number>();
  for (let i = 0; i < allEndpoints.length; i++) {
    const ep = allEndpoints[i];
    if (ep === undefined) continue;
    const c = clusterOf[i];
    if (c === undefined) continue;
    pieceEpCluster.set(`${ep.pieceIdx}:${ep.endpointIdx}`, c);
  }
  return pieceEpCluster;
}

function clusterEndpoints(allEndpoints: ReadonlyArray<EndpointRef>): ClusterResult {
  const clusterOf: number[] = new Array(allEndpoints.length).fill(-1);
  const clusters: number[][] = [];

  for (let i = 0; i < allEndpoints.length; i++) {
    const ep = allEndpoints[i];
    if (ep === undefined) continue;
    let assignedCluster = findNearbyCluster(ep, clusters, allEndpoints);
    if (assignedCluster === -1) {
      assignedCluster = clusters.length;
      clusters.push([]);
    }
    clusterOf[i] = assignedCluster;
    clusters[assignedCluster]?.push(i);
  }

  return { clusters, pieceEpCluster: buildPieceEpMap(allEndpoints, clusterOf) };
}

// ---------------------------------------------------------------------------
// Helpers used in the main compile pass
// ---------------------------------------------------------------------------

function getCluster(pieceEpCluster: ReadonlyMap<string, number>, pi: number, ei: number): number {
  const c = pieceEpCluster.get(`${pi}:${ei}`);
  if (c === undefined) throw new Error(`No cluster for piece ${pi} endpoint ${ei}`);
  return c;
}

function raisePrecedence(
  clusterKind: Map<number, LayoutMarker['kind']>,
  c: number,
  kind: LayoutMarker['kind'],
): void {
  const current = clusterKind.get(c) ?? 'block_boundary';
  if ((KIND_PRECEDENCE[kind] ?? 0) > (KIND_PRECEDENCE[current] ?? 0)) {
    clusterKind.set(c, kind);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — assign marker kinds
// ---------------------------------------------------------------------------

function assignMarkerKinds(
  pieces: ReadonlyArray<TrackPiece>,
  pieceEpCluster: ReadonlyMap<string, number>,
): Map<number, LayoutMarker['kind']> {
  const clusterKind = new Map<number, LayoutMarker['kind']>();

  function raise(pi: number, ei: number, kind: LayoutMarker['kind']): void {
    raisePrecedence(clusterKind, getCluster(pieceEpCluster, pi, ei), kind);
  }

  for (let pi = 0; pi < pieces.length; pi++) {
    const piece = pieces[pi];
    if (piece === undefined) continue;
    switch (piece.type) {
      case 'straight':
      case 'curve': {
        raise(pi, 0, 'block_boundary');
        raise(pi, 1, 'block_boundary');
        break;
      }
      case 'crossing': {
        for (let ei = 0; ei < 4; ei++) raise(pi, ei, 'block_boundary');
        break;
      }
      case 'station': {
        raise(pi, 0, 'block_boundary');
        raise(pi, 1, 'station_stop');
        break;
      }
      case 'junction': {
        raise(pi, 0, 'junction');
        raise(pi, 1, 'block_boundary');
        raise(pi, 2, 'block_boundary');
        break;
      }
      case 'terminus': {
        raise(pi, 0, 'block_boundary');
        break;
      }
    }
  }
  return clusterKind;
}

// ---------------------------------------------------------------------------
// Step 4 — synthesise dead-end markers for terminus pieces
// ---------------------------------------------------------------------------

interface TerminusDeadEnds {
  readonly deadEndByPieceIdx: ReadonlyMap<number, number>;
  readonly extraCentroids: ReadonlyArray<{ x: number; y: number }>;
  readonly deadEndKinds: ReadonlyArray<{ c: number; kind: LayoutMarker['kind'] }>;
}

function buildTerminusDeadEnds(
  pieces: ReadonlyArray<TrackPiece>,
  startClusterIdx: number,
): TerminusDeadEnds {
  const deadEndByPieceIdx = new Map<number, number>();
  const extraCentroids: { x: number; y: number }[] = [];
  const deadEndKinds: { c: number; kind: LayoutMarker['kind'] }[] = [];

  let nextC = startClusterIdx;
  for (let pi = 0; pi < pieces.length; pi++) {
    const piece = pieces[pi];
    if (piece === undefined || piece.type !== 'terminus') continue;
    const deadC = nextC;
    nextC += 1;
    deadEndByPieceIdx.set(pi, deadC);
    deadEndKinds.push({ c: deadC, kind: 'terminus' });
    // Buffer end is at local (-30, 0) after rotation+translation
    const rad = (piece.rotationDeg * Math.PI) / 180;
    extraCentroids.push({
      x: piece.position.x + -30 * Math.cos(rad),
      y: piece.position.y + -30 * Math.sin(rad),
    });
  }
  return { deadEndByPieceIdx, extraCentroids, deadEndKinds };
}

// ---------------------------------------------------------------------------
// Step 5 — emit edges and junctions
// ---------------------------------------------------------------------------

interface EdgesAndJunctions {
  readonly edges: LayoutEdge[];
  readonly junctions: LayoutJunction[];
}

function emitEdgesAndJunctions(
  pieces: ReadonlyArray<TrackPiece>,
  pieceEpCluster: ReadonlyMap<string, number>,
  deadEndByPieceIdx: ReadonlyMap<number, number>,
  idOf: (c: number) => string,
): EdgesAndJunctions {
  const edges: LayoutEdge[] = [];
  const junctions: LayoutJunction[] = [];

  function cid(pi: number, ei: number): string {
    return idOf(getCluster(pieceEpCluster, pi, ei));
  }

  for (let pi = 0; pi < pieces.length; pi++) {
    const piece = pieces[pi];
    if (piece === undefined) continue;
    switch (piece.type) {
      case 'straight':
      case 'curve':
        edges.push({
          from_marker_id: cid(pi, 0),
          to_marker_id: cid(pi, 1),
          estimated_length_mm: 200,
        });
        break;
      case 'station':
        edges.push({
          from_marker_id: cid(pi, 0),
          to_marker_id: cid(pi, 1),
          estimated_length_mm: 220,
        });
        break;
      case 'terminus': {
        const deadC = deadEndByPieceIdx.get(pi);
        if (deadC === undefined) break;
        edges.push({
          from_marker_id: cid(pi, 0),
          to_marker_id: idOf(deadC),
          estimated_length_mm: 60,
        });
        break;
      }
      case 'junction': {
        const trunkId = cid(pi, 0);
        edges.push({
          from_marker_id: trunkId,
          to_marker_id: cid(pi, 1),
          requires_switch_state: 'main',
          estimated_length_mm: 200,
        });
        edges.push({
          from_marker_id: trunkId,
          to_marker_id: cid(pi, 2),
          requires_switch_state: 'divert',
          estimated_length_mm: 200,
        });
        junctions.push({ marker_id: trunkId, valid_positions: ['main', 'divert'] });
        break;
      }
      case 'crossing':
        edges.push({
          from_marker_id: cid(pi, 2),
          to_marker_id: cid(pi, 0),
          estimated_length_mm: 200,
        });
        edges.push({
          from_marker_id: cid(pi, 1),
          to_marker_id: cid(pi, 3),
          estimated_length_mm: 200,
        });
        break;
    }
  }
  return { edges, junctions };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile an array of placed TrackPiece objects into a Trainframe Layout.
 *
 * Algorithm:
 *  1. Collect every endpoint across all pieces.
 *  2. Greedily cluster endpoints within SNAP_DISTANCE_MM (first-seen wins).
 *  3. Assign marker IDs (m1, m2, …) in cluster-discovery order.
 *  4. Emit edges: one per piece for simple pieces; two for junctions/crossings.
 *  5. Emit LayoutJunction entries for junction pieces.
 *
 * Terminus pieces synthesise a private dead-end marker so we can still emit
 * a directed edge even though the piece has only one open endpoint.
 */
export function compileLayout(pieces: ReadonlyArray<TrackPiece>, name: string): Layout {
  const allEndpoints = collectEndpoints(pieces);
  const { clusters, pieceEpCluster } = clusterEndpoints(allEndpoints);

  // Compute cluster centroids
  const clusterCentroid = clusters.map((members) => {
    let sx = 0;
    let sy = 0;
    for (const i of members) {
      const ep = allEndpoints[i];
      if (ep !== undefined) {
        sx += ep.x;
        sy += ep.y;
      }
    }
    const n = members.length > 0 ? members.length : 1;
    return { x: sx / n, y: sy / n };
  });

  const clusterKind = assignMarkerKinds(pieces, pieceEpCluster);

  // Synthesise dead-end markers for terminus pieces
  const { deadEndByPieceIdx, extraCentroids, deadEndKinds } = buildTerminusDeadEnds(
    pieces,
    clusters.length,
  );
  for (const { c, kind } of deadEndKinds) {
    clusterKind.set(c, kind);
  }
  const allCentroids = [...clusterCentroid, ...extraCentroids];
  const totalClusters = clusters.length + extraCentroids.length;

  // Build marker list
  const markers: LayoutMarker[] = [];
  for (let c = 0; c < totalClusters; c++) {
    const kind = clusterKind.get(c) ?? 'block_boundary';
    const centroid = allCentroids[c];
    const id = `m${c + 1}`;
    if (centroid === undefined) {
      markers.push({ id, kind });
    } else {
      markers.push({
        id,
        kind,
        position: { x_mm: Math.round(centroid.x), y_mm: Math.round(centroid.y) },
      });
    }
  }

  function idOf(c: number): string {
    const id = markers[c]?.id;
    if (id === undefined) throw new Error(`No marker for cluster ${c}`);
    return id;
  }

  const { edges, junctions } = emitEdgesAndJunctions(
    pieces,
    pieceEpCluster,
    deadEndByPieceIdx,
    idOf,
  );

  return { name, markers, edges, junctions };
}

// Re-export for convenience
export { SNAP_DISTANCE_MM as SNAP_DISTANCE };
