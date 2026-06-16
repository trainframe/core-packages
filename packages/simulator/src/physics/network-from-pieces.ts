/**
 * Compile a set of FREE-PLACED track pieces (`track/pieces.ts`) into a physics
 * `RailNetwork` — the GEOMETRY sibling of `track/layout-from-pieces.ts`'s logical
 * `compileLayout`. Where `compileLayout` infers the scheduler's marker/edge graph
 * from endpoint adjacency, this infers the drivable rail network a `PhysicsWorld`
 * runs trains on. Its output is interchangeable with `PieceNetworkBuilder`'s
 * (`physics/piece-network.ts`): same `{ net, geom }` conventions, same junction
 * switch-gating, so anything that consumes one consumes the other.
 *
 * ── The orientation problem ─────────────────────────────────────────────────
 * A `Rail` runs start→end, and the network's links are directed `from.end →
 * to.start`: a body leaving a segment at its END enters the next segment at its
 * START, velocity and facing preserved (the network derives the reverse transition
 * — leaving a START re-enters the predecessor's END — itself). So for two pieces
 * whose endpoints snap together, we must ORIENT each piece's rail so that the
 * shared joint is ONE piece's rail-END and the OTHER's rail-START — there is no link
 * form for end-meets-end, so a joint left that way is UNWIRED and a body drives off it
 * (derails). Free-placed pieces carry arbitrary rotation, so we can't read orientation
 * off the geometry; we IMPOSE it. A greedy directed walk (orient each piece the first
 * time it is reached) cannot do this on a REAL layout: cycles and converging junctions
 * make two walk paths reach the same piece demanding OPPOSITE orientations, and the
 * leftover end-meets-end joint derails the train. Orientation is a global CONSTRAINT
 * problem, solved by propagation (a 2-colouring) — see `orientAll`.
 *
 * The algorithm:
 *   1. Collect every non-device piece's world endpoints and cluster them within
 *      `SNAP_DISTANCE_MM` (reusing the helpers `compileLayout` uses), so a ≥2-member
 *      cluster is a physical joint and a 1-member cluster a free / buffer end. A joint
 *      must never hold both endpoints of one piece; a SUB-SNAP filler piece can make
 *      single-linkage snap merge two real joints into one such super-cluster, so those
 *      are re-split tighter (`splitDegenerateClusters`).
 *   2. ORIENT every rail by constraint propagation (`orientAll`). Each simple piece's
 *      rail is a free flip (either endpoint the START); each junction is a coupled flip
 *      — DIVERGING (trunk a rail-START, through/branch ENDs: rails `(0,1)`,`(0,2)`) or
 *      MERGING (trunk a rail-END, through/branch STARTs: rails `(1,0)`,`(2,0)`), the
 *      SAME piece either way. Seeded from one piece per component and flooded across
 *      joints so every joint becomes end↔start. A genuine contradiction (a rail forced
 *      both ways) is a real topology error, recorded in `contradictions` — never a crash.
 *   3. WIRE every joint once from the final orientations (`wireAll`). A junction's two
 *      leg-rails meet external track at its TRUNK, so the trunk joint carries the switch
 *      gate (`when:{switchId, position}`, through→'main' / branch→'divert' from
 *      `switchStateForEndpoint`) selecting the live leg — whether the junction diverges
 *      (inbound→leg) or merges (leg→onward, and its reverse). The switch id is the
 *      junction's marker id (`M-{piece.id}`), the same id `compileLayout` declares it
 *      under, so a switch thrown for one is seen by the other.
 *   4. A `terminus` is a buffered dead-end: its rail reports `terminus` at both ends, so
 *      a body reaching it stops — no special wiring beyond linking its one joint. Device
 *      pieces contribute no track and are skipped. Disconnected components all compile.
 *
 * DEFERRED (documented, not half-implemented): `turntable` (an N-way rotating junction
 * whose deck angle, not a static branch, picks the exit, with facing-flip transitions).
 * It is SKIPPED (left as a non-routing gap, recorded in `contradictions`) rather than
 * throwing — one unsupported piece must not crash a whole layout — see `isDeferred`. NOTE on
 * bridges: a grade-separated self-crossing (a satellite loop ramping over the main on a
 * height layer, as in `interesting-layout.ts`) is NOT a special case here — the crossing
 * pieces are on different layers and share NO joint, so they never cluster; the ramps are
 * ordinary 2-endpoint pieces the propagation orients like any other. The real-layout lap
 * test drives exactly such a layout.
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import {
  type EndpointRef,
  clusterEndpoints,
  collectEndpoints,
  switchStateForEndpoint,
} from '../track/layout-from-pieces.js';
import { type TrackPiece, getEndpoints, isDevicePiece } from '../track/pieces.js';
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import type { SegEndpoints } from './piece-network.js';
import { type Rail, railOfPiece } from './rail.js';

/** The compiled physics network plus the bookkeeping a renderer / marker pass
 *  needs: each segment's world endpoints and which segment(s) each piece made. */
export interface CompiledNetwork {
  readonly net: RailNetwork;
  /** Per segment, its `{ start, end }` world points (rail d 0 / d length) — the
   *  same shape `PieceNetworkBuilder.geom` carries. */
  readonly geom: Map<string, SegEndpoints>;
  /** piece.id → the segment id(s) it produced (a junction makes two). */
  readonly segmentsForPiece: Map<string, string[]>;
  /** Piece ids the orientation pass found non-orientable (the layout forced their
   *  rail both directions) — a real topology error. Empty on a valid layout; the
   *  rest of the network is still compiled around them. */
  readonly contradictions: readonly string[];
}

/** The marker / switch id for a piece — identical to `layout-from-pieces`'
 *  `markerIdForPiece`, so the physics switch id and the logical junction marker
 *  id are the SAME string and one `setSwitch` drives both views. */
function markerIdForPiece(piece: TrackPiece): string {
  return `M-${piece.id}`;
}

/** A track piece's segment id. A junction owns two (through / branch); every other
 *  piece owns one. */
function thruSegId(piece: TrackPiece): string {
  return `S-${piece.id}`;
}
function branchSegId(piece: TrackPiece): string {
  return `S-${piece.id}-b`;
}

/** Whether a piece type's faithful free-placed compilation is DEFERRED (turntable —
 *  an N-way rotating junction; multi-deck bridges are handled by layer separation,
 *  not here). A deferred piece is SKIPPED — left as a non-routing gap and recorded
 *  in the result's `contradictions` — rather than throwing, so one unsupported piece
 *  can never crash a whole layout (a real operator table may carry one). */
function isDeferred(piece: TrackPiece): boolean {
  return piece.type === 'turntable';
}

/** A non-device piece with its world endpoints and the index into the piece array
 *  (the index the endpoint clusters reference). */
interface PieceNode {
  readonly idx: number;
  readonly piece: TrackPiece;
  readonly endpoints: ReadonlyArray<{ x: number; y: number; layer: number }>;
}

/** Which other (piece-index, endpoint-index) pairs share each cluster, keyed by a
 *  piece's endpoint. A joint is a cluster with ≥2 members. */
interface Adjacency {
  /** `pieceIdx -> endpointIdx -> the cluster id` the endpoint belongs to. */
  readonly clusterOf: Map<number, Map<number, number>>;
  /** cluster id -> its members (piece + endpoint). */
  readonly members: Map<number, ReadonlyArray<{ pieceIdx: number; endpointIdx: number }>>;
}

/** Tight re-cluster threshold (mm) for splitting a degenerate super-cluster — see
 *  `splitDegenerateClusters`. Well below `SNAP_DISTANCE_MM` so it separates two true
 *  joints a sub-snap piece bridged, while still grouping near-coincident endpoints. */
const TIGHT_SNAP_MM = 12;

/** Single-linkage group the endpoint indices `idxs` by mutual distance within `tol` —
 *  a tighter re-clustering used only to split a degenerate super-cluster. */
function groupWithin(
  idxs: readonly number[],
  endpoints: ReadonlyArray<EndpointRef>,
  tol: number,
): number[][] {
  const groups: number[][] = [];
  for (const i of idxs) {
    const ep = endpoints[i];
    if (ep === undefined) continue;
    const hit = groups.find((g) =>
      g.some((j) => {
        const o = endpoints[j];
        return o !== undefined && Math.hypot(ep.x - o.x, ep.y - o.y) <= tol;
      }),
    );
    if (hit === undefined) groups.push([i]);
    else hit.push(i);
  }
  return groups;
}

/** A `clusterEndpoints` joint must NEVER contain both endpoints of one piece: those
 *  are the two ends of one rail, not a joint. Single-linkage snap (30 mm) can chain a
 *  SUB-SNAP filler piece's two ends — and its two neighbours — into one super-cluster
 *  (e.g. a 24 mm filler: `[p38#1, p39#0]` at one point and `[p39#1, mp28#1]` 24 mm away
 *  collapse together). That makes the tiny piece present BOTH its roles at one joint, an
 *  unsolvable 2-colouring. Re-split any such cluster with a TIGHTER threshold, which
 *  separates the two genuine joints the snap merged while keeping real coincident
 *  endpoints together. Clusters with no self-pair pass through untouched. */
function splitDegenerateClusters(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  endpoints: ReadonlyArray<EndpointRef>,
): number[][] {
  const out: number[][] = [];
  for (const cluster of clusters) {
    if (cluster === undefined) continue;
    const seen = new Set<number>();
    const selfPair = cluster.some((i) => {
      const p = endpoints[i]?.pieceIdx;
      if (p === undefined) return false;
      if (seen.has(p)) return true;
      seen.add(p);
      return false;
    });
    if (!selfPair) {
      out.push([...cluster]);
      continue;
    }
    for (const g of groupWithin(cluster, endpoints, TIGHT_SNAP_MM)) out.push(g);
  }
  return out;
}

/** Build endpoint clusters and index them both ways. Reuses `compileLayout`'s
 *  `collectEndpoints` / `clusterEndpoints` so adjacency is inferred IDENTICALLY to
 *  the logical compiler, then splits any degenerate sub-snap super-cluster (see
 *  `splitDegenerateClusters`) so no joint holds both ends of one piece. */
function buildAdjacency(pieces: ReadonlyArray<TrackPiece>): {
  endpoints: ReadonlyArray<EndpointRef>;
  adjacency: Adjacency;
} {
  const endpoints = collectEndpoints(pieces);
  const clusters = splitDegenerateClusters(clusterEndpoints(endpoints), endpoints);
  const clusterOf = new Map<number, Map<number, number>>();
  const members = new Map<number, ReadonlyArray<{ pieceIdx: number; endpointIdx: number }>>();
  for (let c = 0; c < clusters.length; c++) {
    const cluster = clusters[c];
    if (cluster === undefined) continue;
    const memberList: { pieceIdx: number; endpointIdx: number }[] = [];
    for (const epIdx of cluster) {
      const ep = endpoints[epIdx];
      if (ep === undefined) continue;
      memberList.push({ pieceIdx: ep.pieceIdx, endpointIdx: ep.endpointIdx });
      const perPiece = clusterOf.get(ep.pieceIdx) ?? new Map<number, number>();
      perPiece.set(ep.endpointIdx, c);
      clusterOf.set(ep.pieceIdx, perPiece);
    }
    members.set(c, memberList);
  }
  return { endpoints, adjacency: { clusterOf, members } };
}

/** The orientation chosen for a non-junction piece: which endpoint is the rail
 *  start (entryIdx) and which the end (exitIdx). Junctions are oriented implicitly
 *  (trunk is always the start of both rails) and don't appear here. */
interface Orientation {
  readonly entryIdx: number;
  readonly exitIdx: number;
}

/** Whether two endpoint indices of an oriented piece are its rail start or end. */
type EndRole = 'start' | 'end';

/** A piece-endpoint whose rail role (start / end) is now KNOWN — the unit the
 *  orientation propagation flows along. The joint it sits in forces the opposite
 *  role on every unoriented neighbour (simple piece or junction) there. */
interface KnownRole {
  readonly pieceIdx: number;
  readonly endpointIdx: number;
  readonly role: EndRole;
}

/** A rail end exposed at a joint: which segment, whether the joint is that rail's
 *  start or end, and (for a junction rail entered at its trunk START) the switch
 *  gate that selects it. The gate rides on the START side because a link is
 *  `from.end → to.start`: entering a junction's through rail is live only on the
 *  through switch position, its branch rail only on the branch position. */
interface RailEnd {
  readonly seg: string;
  readonly role: EndRole;
  readonly gate?: { readonly switchId: string; readonly position: string };
}

/**
 * The stateful compile: build adjacency, orient every piece, then wire joints.
 * Kept as a small class so each step is its own short method (the algorithm is
 * inherently multi-phase, and one giant closure-laden function would be both hard
 * to read and over the cognitive-complexity budget).
 */
class NetworkCompiler {
  private readonly adjacency: Adjacency;
  private readonly nodes: PieceNode[] = [];
  private readonly nodeByIdx = new Map<number, PieceNode>();
  private readonly segments = new Map<string, Rail>();
  private readonly geom = new Map<string, SegEndpoints>();
  private readonly segmentsForPiece = new Map<string, string[]>();
  private readonly links: NetLink[] = [];
  /* The orientation chosen for each non-junction piece (by index), filled as the
   * propagation reaches it. A junction's orientation is its `junctionTrunk` role. */
  private readonly orientation = new Map<number, Orientation>();
  /* The trunk role chosen for each junction (by index): 'start' = diverging (trunk
   * roots both rails), 'end' = merging (both rails end at the trunk). Decided by the
   * orientation propagation, not fixed up front. */
  private readonly junctionTrunk = new Map<number, EndRole>();
  private readonly placed = new Set<number>();
  /* Pieces whose roles have already been enqueued for propagation — so a piece
   * reached from several joints seeds the queue exactly once. */
  private readonly placedBefore = new Set<number>();
  /* Piece ids whose orientation the layout forced both ways — a real topology error
   * (a non-orientable joint). Recorded, not thrown: the rest still compiles. */
  private readonly contradictions: string[] = [];

  constructor(pieces: readonly TrackPiece[]) {
    this.adjacency = buildAdjacency(pieces).adjacency;
    /* Only non-device, non-deferred pieces are routable topology (devices ride the
     * track — `compileLayout` skips them too; deferred pieces like a turntable are
     * left as a recorded gap, never thrown, so one can't crash a whole layout). */
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece === undefined || isDevicePiece(piece.type)) continue;
      if (isDeferred(piece)) {
        this.contradictions.push(`deferred: ${piece.type} (${piece.id}) left as a non-routing gap`);
        continue;
      }
      const eps = getEndpoints(piece).map((e) => ({ x: e.x, y: e.y, layer: e.layer }));
      if (eps.length === 0) continue;
      const node: PieceNode = { idx: i, piece, endpoints: eps };
      this.nodes.push(node);
      this.nodeByIdx.set(i, node);
    }
  }

  compile(): CompiledNetwork {
    this.orientAll();
    this.wireAll();
    return {
      net: buildNetwork(this.segments, this.links),
      geom: this.geom,
      segmentsForPiece: this.segmentsForPiece,
      contradictions: this.contradictions,
    };
  }

  private isJunction(node: PieceNode): boolean {
    return node.piece.type === 'junction';
  }

  private thruSegId(node: PieceNode): string {
    return thruSegId(node.piece);
  }

  /** Emit a simple piece's single oriented rail and record it, once. */
  private place(node: PieceNode, o: Orientation): void {
    if (this.placed.has(node.idx)) return;
    this.placed.add(node.idx);
    this.orientation.set(node.idx, o);
    const id = thruSegId(node.piece);
    this.emitRail(id, railOfPiece(node.piece, o.entryIdx, o.exitIdx));
    this.segmentsForPiece.set(node.piece.id, [id]);
  }

  /** Emit a junction's two rails for the chosen trunk role and record them, once.
   *  A junction's two rails SHARE the trunk endpoint and are oriented together: a
   *  DIVERGING junction (trunk a rail-START) runs trunk→through `(0,1)` and
   *  trunk→branch `(0,2)`; a MERGING junction (trunk a rail-END) runs through→trunk
   *  `(1,0)` and branch→trunk `(2,0)` — exactly the two cases `PieceNetworkBuilder`'s
   *  `junction()` / `mergeJunction()` build. Which it is is NOT fixed a priori; it is
   *  decided by the same orientation propagation that orients simple pieces, because a
   *  junction tapped one way diverges and the SAME piece tapped the other merges. */
  private placeJunction(node: PieceNode, trunkRole: EndRole): void {
    if (this.placed.has(node.idx)) return;
    this.placed.add(node.idx);
    this.junctionTrunk.set(node.idx, trunkRole);
    const [thruA, thruB, branchA, branchB] =
      trunkRole === 'start' ? ([0, 1, 0, 2] as const) : ([1, 0, 2, 0] as const);
    this.emitRail(thruSegId(node.piece), railOfPiece(node.piece, thruA, thruB));
    this.emitRail(branchSegId(node.piece), railOfPiece(node.piece, branchA, branchB));
    this.segmentsForPiece.set(node.piece.id, [thruSegId(node.piece), branchSegId(node.piece)]);
  }

  private emitRail(id: string, rail: Rail): void {
    this.segments.set(id, rail);
    this.geom.set(id, { start: rail.at(0), end: rail.at(rail.length) });
  }

  /** The exit endpoint of a simple piece given its entry (the other of its two). */
  private pickExit(node: PieceNode, entryIdx: number): number {
    for (let k = 0; k < node.endpoints.length; k++) if (k !== entryIdx) return k;
    return entryIdx === 0 ? 1 : 0;
  }

  /** The members (piece + endpoint) of the joint that `node`'s `endpointIdx` belongs
   *  to, INCLUDING `node` itself. A 1-member result is a free / buffer end. */
  private jointMembersAt(
    node: PieceNode,
    endpointIdx: number,
  ): ReadonlyArray<{ pieceIdx: number; endpointIdx: number }> {
    const clusterId = this.adjacency.clusterOf.get(node.idx)?.get(endpointIdx);
    if (clusterId === undefined) return [{ pieceIdx: node.idx, endpointIdx }];
    return this.adjacency.members.get(clusterId) ?? [{ pieceIdx: node.idx, endpointIdx }];
  }

  /* ── Phase 1: orient every rail by constraint propagation (2-colouring) ─────
   *
   * The orientation problem is a constraint-satisfaction one, NOT a tree walk. Every
   * piece's rail(s) may be built either way round, which is a binary choice:
   *   - a SIMPLE piece's single rail runs endpoint-a→b or b→a (one endpoint is the
   *     rail START, the other the END);
   *   - a JUNCTION's two rails SHARE the trunk endpoint and flip TOGETHER: either the
   *     trunk roots both rails (a DIVERGING turnout: trunk a START, through/branch
   *     ENDs) or both rails end at the trunk (a MERGING turnout: trunk an END,
   *     through/branch STARTs). The SAME junction piece is a diverge when tapped one
   *     way and a merge the other, so this is NOT fixed a priori — `PieceNetworkBuilder`
   *     builds both from one piece via `junction()` vs `mergeJunction()`.
   * The hard constraint at every 2-member joint is that a body must flow end→start
   * across it: one side presents an END, the other a START (the network's only link
   * form is `from.end → to.start`). A greedy directed walk cannot satisfy this
   * globally — on a layout with cycles and many junctions, two walk paths reach the
   * same piece demanding OPPOSITE orientations, leaving an unwireable end-meets-end
   * joint a body runs off (derails).
   *
   * We instead PROPAGATE the constraint. The "role" of a piece-endpoint is whether it
   * presents its rail's START or END at its joint. We seed one piece's orientation,
   * then flood-fill across joints: at a joint with an already-known role on one side,
   * an as-yet-unoriented neighbour is oriented so its endpoint there takes the
   * OPPOSITE role (a known END forces the neighbour to present a START there — that
   * endpoint becomes its ENTRY/trunk-as-end; a known START forces an END there).
   * Orienting any piece fixes ALL its endpoints' roles, which feeds the queue onward.
   * This uses the freedom to flip every rail — simple AND junction — to satisfy the
   * neighbours and close cycles consistently, exactly what the greedy walk could not.
   * Each connected component is seeded once from an arbitrary piece (its absolute
   * orientation is free; only the RELATIVE alternation matters). A valid drivable
   * layout is always consistently 2-colourable this way; a genuine contradiction (a
   * rail forced both ways) is a real topology error, recorded in `contradictions` and
   * skipped — never a crash. */
  private orientAll(): void {
    for (const node of this.nodes) {
      if (this.placed.has(node.idx)) continue;
      /* Seed this component: orient `node` arbitrarily (a simple piece entered at
       * endpoint 0; a junction as a diverge) and flood the rest off it. */
      this.orientPiece(node, 0, 'start');
      this.placedBefore.add(node.idx);
      this.propagate(this.rolesOf(node));
    }
  }

  /** Flood the orientation constraint outward from a queue of newly-known roles: at
   *  each known role, find the joint it sits in and orient any unoriented neighbour
   *  (simple or junction) so its endpoint there takes the OPPOSITE role, enqueuing the
   *  neighbour's now-known roles. */
  private propagate(queue: KnownRole[]): void {
    /* A role is processed at most ONCE (keyed piece:endpoint). Without this a piece
     * reached from several joints would re-enqueue its roles unboundedly. */
    const seen = new Set<string>();
    while (queue.length > 0) {
      const known = queue.pop();
      if (known === undefined) continue;
      const key = `${known.pieceIdx}:${known.endpointIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.propagateFrom(known, queue);
    }
  }

  /** Orient every unoriented neighbour at `known`'s joint to the opposite role and
   *  enqueue their roles. The neighbour must present `opposite` at its endpoint there:
   *  a known END here → neighbour presents a START there; a known START → an END. */
  private propagateFrom(known: KnownRole, queue: KnownRole[]): void {
    const node = this.nodeByIdx.get(known.pieceIdx);
    if (node === undefined) return;
    const opposite: EndRole = known.role === 'end' ? 'start' : 'end';
    for (const m of this.jointMembersAt(node, known.endpointIdx)) {
      if (m.pieceIdx === known.pieceIdx) continue;
      const nb = this.nodeByIdx.get(m.pieceIdx);
      if (nb === undefined) continue;
      this.orientPiece(nb, m.endpointIdx, opposite);
      if (!this.placedBefore.has(nb.idx)) {
        this.placedBefore.add(nb.idx);
        for (const r of this.rolesOf(nb)) queue.push(r);
      }
    }
  }

  /** Orient (and emit) a piece so its endpoint `atIdx` presents `role`, unless it is
   *  already oriented — in which case verify the new demand AGREES, recording a
   *  topology error if it contradicts (a rail the layout forces both ways). A simple
   *  piece's `atIdx` becomes its ENTRY when `role` is 'start', its EXIT when 'end'. A
   *  junction's trunk role is fixed by `atIdx`: if `atIdx` is the trunk, the trunk
   *  takes `role` directly; otherwise (a through/branch endpoint) the trunk takes the
   *  OPPOSITE of `role` (trunk and through/branch are always opposite). */
  private orientPiece(node: PieceNode, atIdx: number, role: EndRole): void {
    if (this.isJunction(node)) {
      const trunkRole: EndRole = atIdx === 0 ? role : role === 'start' ? 'end' : 'start';
      this.orientJunction(node, trunkRole);
      return;
    }
    const entryIdx = role === 'start' ? atIdx : this.pickExit(node, atIdx);
    const existing = this.orientation.get(node.idx);
    if (existing !== undefined) {
      if (existing.entryIdx !== entryIdx) this.contradictions.push(node.piece.id);
      return;
    }
    this.place(node, { entryIdx, exitIdx: this.pickExit(node, entryIdx) });
  }

  private orientJunction(node: PieceNode, trunkRole: EndRole): void {
    const existing = this.junctionTrunk.get(node.idx);
    if (existing !== undefined) {
      if (existing !== trunkRole) this.contradictions.push(node.piece.id);
      return;
    }
    this.placeJunction(node, trunkRole);
  }

  /** The now-known endpoint roles of an oriented piece, as propagation seeds. A simple
   *  piece exposes entry=start / exit=end; a junction exposes its trunk role at
   *  endpoint 0 and the OPPOSITE at through(1)/branch(2). Empty if not yet oriented. */
  private rolesOf(node: PieceNode): KnownRole[] {
    if (this.isJunction(node)) {
      const trunk = this.junctionTrunk.get(node.idx);
      if (trunk === undefined) return [];
      const leg: EndRole = trunk === 'start' ? 'end' : 'start';
      return [
        { pieceIdx: node.idx, endpointIdx: 0, role: trunk },
        { pieceIdx: node.idx, endpointIdx: 1, role: leg },
        { pieceIdx: node.idx, endpointIdx: 2, role: leg },
      ];
    }
    const o = this.orientation.get(node.idx);
    if (o === undefined) return [];
    return [
      { pieceIdx: node.idx, endpointIdx: o.entryIdx, role: 'start' },
      { pieceIdx: node.idx, endpointIdx: o.exitIdx, role: 'end' },
    ];
  }

  /** The rail end(s) endpoint `endpointIdx` of a placed piece exposes at its joint:
   *  segment + whether it is that rail's start or end, plus (for a junction trunk)
   *  the switch gate selecting each rail. For a junction the trunk (0) is the START
   *  of both rails; through (1) / branch (2) are their ENDS. For a simple piece the
   *  endpoint is the start when it is the entry, the end otherwise. */
  private endRoleAt(node: PieceNode, endpointIdx: number): ReadonlyArray<RailEnd> {
    if (this.isJunction(node)) return this.junctionRoleAt(node, endpointIdx);
    const o = this.orientation.get(node.idx);
    if (o === undefined) return [];
    return [{ seg: this.thruSegId(node), role: endpointIdx === o.entryIdx ? 'start' : 'end' }];
  }

  /** The rail end a junction exposes at endpoint `endpointIdx`, given its chosen trunk
   *  role (diverge: trunk a START, legs ENDs; merge: trunk an END, legs STARTs). BOTH
   *  leg-rails meet the external track at the TRUNK, so that is the one joint where the
   *  switch must pick between them — the trunk therefore exposes BOTH leg-rails, each
   *  carrying its switch position (through→'main', branch→'divert'); the link selecting
   *  the live leg is live only on that position. This holds whether the junction
   *  diverges (the inbound→trunk link picks the outgoing leg-rail) or merges (the
   *  trunk→onward link, and its reverse, pick the incoming leg-rail). The leg endpoints
   *  meet exactly one external rail each, so no selection happens there — they are
   *  plain. */
  private junctionRoleAt(node: PieceNode, endpointIdx: number): ReadonlyArray<RailEnd> {
    const trunkRole = this.junctionTrunk.get(node.idx) ?? 'start';
    if (endpointIdx === 0) {
      const sw = markerIdForPiece(node.piece);
      return [
        this.junctionLeg(
          thruSegId(node.piece),
          trunkRole,
          sw,
          switchStateForEndpoint(node.piece, 1),
        ),
        this.junctionLeg(
          branchSegId(node.piece),
          trunkRole,
          sw,
          switchStateForEndpoint(node.piece, 2),
        ),
      ];
    }
    const legRole: EndRole = trunkRole === 'start' ? 'end' : 'start';
    const seg = endpointIdx === 1 ? thruSegId(node.piece) : branchSegId(node.piece);
    return [{ seg, role: legRole }];
  }

  /** A leg-rail as exposed at the trunk: its trunk role plus the switch gate that
   *  selects it (absent only for a non-switched piece). */
  private junctionLeg(
    seg: string,
    trunkRole: EndRole,
    switchId: string,
    position: string | undefined,
  ): RailEnd {
    if (position === undefined) return { seg, role: trunkRole };
    return { seg, role: trunkRole, gate: { switchId, position } };
  }

  /* ── Phase 2: wire every joint once from the final orientations ────────────
   * Each cluster of ≥2 endpoints is wired between each rail that ENDS there and each
   * rail that STARTS there (a junction exposes two starts at its trunk). Because
   * orientation is globally consistent, every running joint resolves to a clean
   * `end → start` link; the network derives the reverse direction itself, so the
   * loop is bidirectional and closes on itself. */
  private wireAll(): void {
    for (const [, memberList] of this.adjacency.members) {
      if (memberList.length < 2) continue; // a free / buffer end — nothing to wire
      for (let i = 0; i < memberList.length; i++) {
        for (let j = i + 1; j < memberList.length; j++) {
          this.wirePair(memberList[i], memberList[j]);
        }
      }
    }
  }

  private wirePair(
    m: { pieceIdx: number; endpointIdx: number } | undefined,
    n: { pieceIdx: number; endpointIdx: number } | undefined,
  ): void {
    if (m === undefined || n === undefined) return;
    const mNode = this.nodeByIdx.get(m.pieceIdx);
    const nNode = this.nodeByIdx.get(n.pieceIdx);
    if (mNode === undefined || nNode === undefined) return;
    for (const ar of this.endRoleAt(mNode, m.endpointIdx)) {
      for (const br of this.endRoleAt(nNode, n.endpointIdx)) this.wireEnds(ar, br);
    }
  }

  /** Wire one pair of rail ends meeting at a joint. A link is `end → start`; its gate
   *  (if any) comes from whichever side is a SWITCHED junction leg-rail (only one side
   *  ever carries a gate), so the link is live only on that leg's switch position —
   *  whether the leg is the END (a diverge's leg→onward) or the START (a merge's
   *  incoming→leg). With consistent orientation a running joint is always end↔start; an
   *  end-meets-end or start-meets-start pair only occurs at a real topology error and is
   *  recorded and left unwired (never silently driven off). */
  private wireEnds(ar: RailEnd, br: RailEnd): void {
    const gate = ar.gate ?? br.gate;
    if (ar.role === 'end' && br.role === 'start') this.addLink(ar.seg, br.seg, gate);
    else if (ar.role === 'start' && br.role === 'end') this.addLink(br.seg, ar.seg, gate);
    else this.contradictions.push(`${ar.seg}~${br.seg}`);
  }

  /** Append a link unless an identical one already exists (a joint is visited from
   *  both its endpoints, so the same directed link can be proposed twice). */
  private addLink(
    from: string,
    to: string,
    when: { switchId: string; position: string } | undefined,
  ): void {
    const dup = this.links.some(
      (l) =>
        l.from === from &&
        l.to === to &&
        l.when?.switchId === when?.switchId &&
        l.when?.position === when?.position,
    );
    if (dup) return;
    this.links.push(when === undefined ? { from, to } : { from, to, when });
  }
}

/**
 * Compile free-placed track pieces into a physics `RailNetwork`. See the file
 * header for the orientation algorithm. Device pieces are skipped; turntables and
 * turntables are deferred (skipped as a recorded gap, not thrown). Pure geometry/topology.
 */
export function compileNetwork(pieces: readonly TrackPiece[]): CompiledNetwork {
  return new NetworkCompiler(pieces).compile();
}
