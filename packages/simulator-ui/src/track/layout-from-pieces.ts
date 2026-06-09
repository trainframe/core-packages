import type { Layout, LayoutEdge, LayoutJunction, LayoutMarker } from '@trainframe/protocol';
import { TURNTABLE_POSITIONS, getEndpoints, pieceMarkerKind } from './pieces.js';
import type { TrackPiece } from './pieces.js';

/**
 * Snap distance in mm. Two endpoints within this distance are treated as
 * the same physical connection point — i.e. their owning pieces are
 * adjacent on the table.
 */
export const SNAP_DISTANCE_MM = 30;

interface EndpointRef {
  readonly pieceIdx: number;
  readonly endpointIdx: number;
  readonly x: number;
  readonly y: number;
  /** The endpoint's height layer (from `TrackEndpoint.layer`). Two endpoints at
   * the same (x, y) on different layers must NOT cluster — that disjoint
   * connectivity is exactly what distinguishes a bridge from a crossing. */
  readonly layer: number;
}

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
      refs.push({ pieceIdx: pi, endpointIdx: ei, x: ep.x, y: ep.y, layer: ep.layer });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Step 2 — greedy clustering (used only to detect adjacency)
// ---------------------------------------------------------------------------

/**
 * Find the index of the first cluster whose representative endpoint is within
 * snap distance AND on the same layer. The layer-equality test is a
 * *precondition* of the distance test (continue on mismatch, never
 * short-circuit to -1): two stacked bridge endpoints are 0 mm apart in plan and
 * would otherwise merge into one marker — the exact thing a bridge must avoid.
 *
 * Invariant: every cluster member therefore shares the representative's layer,
 * so a cluster is layer-homogeneous by construction and compiles to exactly one
 * marker on exactly one layer. That homogeneity is what makes comparing against
 * the representative alone sound.
 */
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
    if (ep.layer !== repEp.layer) continue;
    const dx = ep.x - repEp.x;
    const dy = ep.y - repEp.y;
    if (Math.sqrt(dx * dx + dy * dy) <= SNAP_DISTANCE_MM) return c;
  }
  return -1;
}

function clusterEndpoints(
  allEndpoints: ReadonlyArray<EndpointRef>,
): ReadonlyArray<readonly number[]> {
  const clusters: number[][] = [];
  for (let i = 0; i < allEndpoints.length; i++) {
    const ep = allEndpoints[i];
    if (ep === undefined) continue;
    let assignedCluster = findNearbyCluster(ep, clusters, allEndpoints);
    if (assignedCluster === -1) {
      assignedCluster = clusters.length;
      clusters.push([]);
    }
    clusters[assignedCluster]?.push(i);
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Step 3 — switch state for a junction endpoint
// ---------------------------------------------------------------------------

/**
 * Edges leaving a junction marker (M-junction → neighbour) carry a switch
 * state that says which physical path through the junction the train will
 * take. For the three junction endpoints:
 *   - 0 (trunk):  always reachable; no switch constraint
 *   - 1 (main):   requires_switch_state = 'main'
 *   - 2 (divert): requires_switch_state = 'divert'
 *
 * Inbound edges (neighbour → M-junction) carry no switch state — the schema's
 * convention is that `requires_switch_state` applies only when `from_marker_id`
 * is a junction.
 */
function switchStateForJunctionEndpoint(endpointIdx: number): string | undefined {
  if (endpointIdx === 1) return 'main';
  if (endpointIdx === 2) return 'divert';
  return undefined;
}

/**
 * A turntable (experimental 002) is, to the compiler, a junction with MORE
 * position strings: trunk at 0, then one position per exit stub. This is the
 * N-way door `LayoutJunction.valid_positions` was designed to leave open — no
 * new event, capability, or scheduler branch; only more labels.
 */
function switchStateForTurntableEndpoint(endpointIdx: number): string | undefined {
  if (endpointIdx === 0) return undefined; // trunk — always reachable
  return TURNTABLE_POSITIONS[endpointIdx - 1];
}

/** The switch state an edge leaving `from` via `fromEndpointIdx` requires,
 * or undefined for non-switched pieces / the trunk approach. */
function switchStateForEndpoint(from: TrackPiece, fromEndpointIdx: number): string | undefined {
  if (from.type === 'junction') return switchStateForJunctionEndpoint(fromEndpointIdx);
  if (from.type === 'turntable') return switchStateForTurntableEndpoint(fromEndpointIdx);
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 4 — emit edges from adjacency
// ---------------------------------------------------------------------------

interface PieceEndpointMember {
  readonly pieceIdx: number;
  readonly endpointIdx: number;
}

function membersOfCluster(
  cluster: ReadonlyArray<number>,
  allEndpoints: ReadonlyArray<EndpointRef>,
): ReadonlyArray<PieceEndpointMember> {
  const members: PieceEndpointMember[] = [];
  for (const i of cluster) {
    const ep = allEndpoints[i];
    if (ep === undefined) continue;
    members.push({ pieceIdx: ep.pieceIdx, endpointIdx: ep.endpointIdx });
  }
  return members;
}

function markerIdForPiece(piece: TrackPiece): string {
  return `M-${piece.id}`;
}

function pieceCenterDistance(a: TrackPiece, b: TrackPiece): number {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Emit a single directed edge from piece A to piece B, respecting the rules
 * for the FROM piece's type:
 *   - terminus on the FROM side: no outbound edge (terminus is a dead-end).
 *   - junction on the FROM side: switch state from the junction endpoint.
 *   - everything else: a plain edge.
 *
 * `estimated_length_mm` is the Euclidean distance between the pieces' centres,
 * rounded. For two adjacent 200 mm straights that comes out to 200, for a
 * straight↔station it's 210, and so on — enough fidelity for the in-browser
 * sim to drive trains at a sensible speed.
 */
function emitDirectedEdge(
  from: TrackPiece,
  fromEndpointIdx: number,
  to: TrackPiece,
): LayoutEdge | undefined {
  if (from.type === 'terminus') return undefined;
  const edge: LayoutEdge = {
    from_marker_id: markerIdForPiece(from),
    to_marker_id: markerIdForPiece(to),
    estimated_length_mm: Math.round(pieceCenterDistance(from, to)),
  };
  const state = switchStateForEndpoint(from, fromEndpointIdx);
  if (state !== undefined) return { ...edge, requires_switch_state: state };
  return edge;
}

function emitEdgesForCluster(
  pieces: ReadonlyArray<TrackPiece>,
  members: ReadonlyArray<PieceEndpointMember>,
  out: LayoutEdge[],
): void {
  for (const a of members) {
    const fromPiece = pieces[a.pieceIdx];
    if (fromPiece === undefined) continue;
    for (const b of members) {
      if (a.pieceIdx === b.pieceIdx) continue;
      const toPiece = pieces[b.pieceIdx];
      if (toPiece === undefined) continue;
      const edge = emitDirectedEdge(fromPiece, a.endpointIdx, toPiece);
      if (edge !== undefined) out.push(edge);
    }
  }
}

function emitEdgesForClusters(
  pieces: ReadonlyArray<TrackPiece>,
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  allEndpoints: ReadonlyArray<EndpointRef>,
): LayoutEdge[] {
  // Every ordered pair of distinct pieces in the same cluster is adjacent and
  // gets one directed edge (subject to terminus/junction rules).
  const edges: LayoutEdge[] = [];
  for (const cluster of clusters) {
    const members = membersOfCluster(cluster, allEndpoints);
    emitEdgesForCluster(pieces, members, edges);
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Step 5 — junction entries
// ---------------------------------------------------------------------------

function emitJunctions(pieces: ReadonlyArray<TrackPiece>): LayoutJunction[] {
  const junctions: LayoutJunction[] = [];
  for (const piece of pieces) {
    if (piece.type === 'junction') {
      junctions.push({
        marker_id: markerIdForPiece(piece),
        valid_positions: ['main', 'divert'],
      });
    } else if (piece.type === 'turntable') {
      // Three positions on one junction marker — the N-way proof of
      // experimental 002, carried by the existing schema unchanged.
      junctions.push({
        marker_id: markerIdForPiece(piece),
        valid_positions: [...TURNTABLE_POSITIONS],
      });
    }
  }
  return junctions;
}

// ---------------------------------------------------------------------------
// Step 6 — markers (one per non-device piece, at the piece's centre)
// ---------------------------------------------------------------------------

function emitMarkers(pieces: ReadonlyArray<TrackPiece>): LayoutMarker[] {
  const markers: LayoutMarker[] = [];
  for (const piece of pieces) {
    const endpoints = getEndpoints(piece);
    // Devices (train, gate) have no endpoints — skip; they aren't topology.
    if (endpoints.length === 0) continue;
    markers.push({
      id: markerIdForPiece(piece),
      kind: pieceMarkerKind(piece.type),
      position: {
        x_mm: Math.round(piece.position.x),
        y_mm: Math.round(piece.position.y),
      },
    });
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile an array of placed TrackPiece objects into a Trainframe Layout.
 *
 * Per-piece markers, edges from adjacency:
 *  1. One marker per non-device piece, id `M-{piece.id}`, kind derived from
 *     `pieceMarkerKind` — the same mapping the scan flow publishes from the
 *     synthetic GARAGE device. The two MUST agree, otherwise the server and
 *     the in-browser sim disagree on what `M-straight-1` means.
 *  2. Endpoints are clustered (within SNAP_DISTANCE_MM) only to detect which
 *     pieces are physically adjacent on the table. No marker is created for
 *     a cluster itself.
 *  3. For every pair of distinct pieces in the same cluster, emit directed
 *     edges in both directions between their markers. Terminus pieces emit
 *     no outbound edges (dead-end). Junction pieces tag their outbound edges
 *     with `requires_switch_state` according to which endpoint joins which
 *     neighbour (trunk = no constraint, main / divert = the matching state).
 *  4. Edge length is Euclidean centre-to-centre distance, rounded.
 *  5. Junction pieces also produce a `LayoutJunction` entry declaring the
 *     marker as a switch with `['main', 'divert']` positions.
 */
export function compileLayout(pieces: ReadonlyArray<TrackPiece>, name: string): Layout {
  const allEndpoints = collectEndpoints(pieces);
  const clusters = clusterEndpoints(allEndpoints);
  const markers = emitMarkers(pieces);
  const edges = emitEdgesForClusters(pieces, clusters, allEndpoints);
  const junctions = emitJunctions(pieces);
  return { name, markers, edges, junctions };
}

// Re-export for convenience
export { SNAP_DISTANCE_MM as SNAP_DISTANCE };
