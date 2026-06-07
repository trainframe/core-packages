import { describe, expect, it } from 'vitest';
import { compileLayout } from '../track/layout-from-pieces.js';
import { detectSameLayerOverlaps } from '../track/overlap.js';
import { layerOf } from '../track/pieces.js';
import { buildBridgeDemo } from './bridge-demo.js';

// ---------------------------------------------------------------------------
// Build once — every assertion reads the same compiled layout.
// ---------------------------------------------------------------------------

const demo = buildBridgeDemo();
const layout = compileLayout(demo.pieces, 'bridge-demo');

type Layout = typeof layout;
type Edge = (typeof layout.edges)[number];

/** Map marker id → its piece (track pieces only; trains have no marker). */
const pieceByMarker = new Map<string, (typeof demo.pieces)[number]>(
  demo.pieces.filter((p) => p.type !== 'train').map((p) => [`M-${p.id}`, p] as const),
);

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/** Undirected adjacency over all markers, optionally skipping a set of
 * `from|to` directed-edge keys (used to "cut" the divert legs). */
function buildAdjacency(l: Layout, cut: ReadonlySet<string> = new Set()): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const m of l.markers) adj.set(m.id, new Set());
  for (const e of l.edges) {
    if (cut.has(`${e.from_marker_id}|${e.to_marker_id}`)) continue;
    adj.get(e.from_marker_id)?.add(e.to_marker_id);
    adj.get(e.to_marker_id)?.add(e.from_marker_id);
  }
  return adj;
}

/** The set of markers reachable from `start` over `adj` (BFS). */
function reachable(adj: ReadonlyMap<string, Set<string>>, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    for (const n of adj.get(next) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Layer helpers (for the grade-separation proof)
// ---------------------------------------------------------------------------

/** True when both endpoints of the edge are layer-1 pieces (a deck edge). */
function isLayer1DeckEdge(e: Edge): boolean {
  const a = pieceByMarker.get(e.from_marker_id);
  const b = pieceByMarker.get(e.to_marker_id);
  return a !== undefined && b !== undefined && layerOf(a) === 1 && layerOf(b) === 1;
}

/** True when both edge endpoints are MAIN-chain ground markers. */
function isMainGroundEdge(e: Edge): boolean {
  const a = pieceByMarker.get(e.from_marker_id);
  const b = pieceByMarker.get(e.to_marker_id);
  return (
    e.from_marker_id.startsWith('M-mn') &&
    e.to_marker_id.startsWith('M-mn') &&
    a !== undefined &&
    b !== undefined &&
    layerOf(a) === 0 &&
    layerOf(b) === 0
  );
}

// ---------------------------------------------------------------------------
// One connected component
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — unified connectivity', () => {
  it('compiles to a single connected component (every marker reachable)', () => {
    expect(layout.markers.length).toBeGreaterThan(0);
    const adj = buildAdjacency(layout);
    const first = layout.markers[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const seen = reachable(adj, first.id);
    expect(seen.size).toBe(layout.markers.length);
  });

  it('exposes both junctions, both ground stations and the upper station', () => {
    const ids = new Set(layout.markers.map((m) => m.id));
    expect(ids.has(demo.junctionId)).toBe(true);
    for (const s of demo.groundStations) expect(ids.has(s)).toBe(true);
    expect(ids.has(demo.upperStation)).toBe(true);
    // The named stations really are station stops in the compiled layout.
    const stations = new Set(
      layout.markers.filter((m) => m.kind === 'station_stop').map((m) => m.id),
    );
    for (const s of demo.groundStations) expect(stations.has(s)).toBe(true);
    expect(stations.has(demo.upperStation)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// J1 diverge: emits a 'main' AND a 'divert' outbound edge
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — J1 diverge', () => {
  it("J1 emits both a 'main' and a 'divert' outbound edge", () => {
    const j1Out = layout.edges.filter((e) => e.from_marker_id === demo.junctionId);
    const states = new Set(j1Out.map((e) => e.requires_switch_state));
    expect(states.has('main')).toBe(true);
    expect(states.has('divert')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Grade separation — the deck genuinely crosses OVER the ground, with NO
// same-layer overlap anywhere (the "clean" bar).
// ---------------------------------------------------------------------------

/** A 2D point. */
interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Signed area of triangle (o, p, q) — its sign is the orientation of the turn
 * o→p→q. Used to test strict segment intersection. */
function orient(o: Pt, p: Pt, q: Pt): number {
  return (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
}

/** True when segments a-b and c-d strictly cross (proper intersection: the two
 * endpoints of each segment fall on opposite sides of the other). Touching at a
 * shared endpoint is NOT a crossing. */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Marker-id → its 2D position (piece centre) in the compiled layout. Markers
 * without a recorded position (`position` is optional on the wire) are omitted;
 * the crossing search skips any edge touching one. */
const markerPos = new Map<string, Pt>(
  layout.markers
    .filter(
      (m): m is typeof m & { position: NonNullable<typeof m.position> } => m.position !== undefined,
    )
    .map((m) => [m.id, { x: m.position.x_mm, y: m.position.y_mm }] as const),
);

/** The layer (0 ground, 1 deck) of a marker, via its owning piece. */
function markerLayer(id: string): number | undefined {
  const p = pieceByMarker.get(id);
  return p === undefined ? undefined : layerOf(p);
}

/** Undirected, de-duplicated edge list (the compiler emits both directions). */
function undirectedEdges(): ReadonlyArray<{ a: string; b: string }> {
  const seen = new Set<string>();
  const out: { a: string; b: string }[] = [];
  for (const e of layout.edges) {
    const key = [e.from_marker_id, e.to_marker_id].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: e.from_marker_id, b: e.to_marker_id });
  }
  return out;
}

/** The endpoints of an undirected edge as 2D points, or undefined if either
 * marker has no recorded position. */
function edgeSegment(e: { a: string; b: string }): { p: Pt; q: Pt } | undefined {
  const p = markerPos.get(e.a);
  const q = markerPos.get(e.b);
  return p === undefined || q === undefined ? undefined : { p, q };
}

/**
 * All grade-separated crossings: a layer-1↔layer-1 edge whose 2D segment
 * strictly crosses a layer-0↔layer-0 edge's segment. Generic over the compiled
 * graph (not pinned to ids) so it survives piece renames. A side-viaduct (deck
 * alongside the ground, never crossing) yields an EMPTY list.
 */
function gradeSeparatedCrossings(): string[] {
  const edges = undirectedEdges();
  const onLayer = (n: number) => (e: { a: string; b: string }) =>
    markerLayer(e.a) === n && markerLayer(e.b) === n;
  const deckEdges = edges.filter(onLayer(1));
  const groundEdges = edges.filter(onLayer(0));
  const crossings: string[] = [];
  for (const deck of deckEdges) {
    const ds = edgeSegment(deck);
    if (ds === undefined) continue;
    for (const ground of groundEdges) {
      const gs = edgeSegment(ground);
      if (gs === undefined) continue;
      if (segmentsCross(ds.p, ds.q, gs.p, gs.q)) {
        crossings.push(`${deck.a}->${deck.b} OVER ${ground.a}->${ground.b}`);
      }
    }
  }
  return crossings;
}

describe('buildBridgeDemo — grade-separated deck', () => {
  it('the deck pieces sit on layer 1, distinct from the layer-0 ground loop', () => {
    const deckEdges = layout.edges.filter(isLayer1DeckEdge);
    const groundEdges = layout.edges.filter(isMainGroundEdge);
    expect(deckEdges.length).toBeGreaterThan(0);
    expect(groundEdges.length).toBeGreaterThan(0);
    // The upper station really is a layer-1 piece.
    const upper = pieceByMarker.get(demo.upperStation);
    expect(upper).toBeDefined();
    if (upper !== undefined) expect(layerOf(upper)).toBe(1);
  });

  it('the deck never spuriously joins the main bypass on the graph (no M-mn↔M-dk edge)', () => {
    // The graph correctness invariant that actually matters: the deck bypass and
    // the main bypass are disjoint paths through the junctions, never short-
    // circuited by an accidental adjacency. (If they joined, the planner could
    // route B onto the deck or A onto the ground straight and the gate would pass
    // only by shortest-path luck.)
    const spurious = layout.edges.filter((e) => {
      const a = e.from_marker_id;
      const b = e.to_marker_id;
      return (
        (a.startsWith('M-mn') && b.startsWith('M-dk')) ||
        (a.startsWith('M-dk') && b.startsWith('M-mn'))
      );
    });
    expect(spurious).toHaveLength(0);
  });

  it('a layer-1 deck edge crosses OVER a layer-0 ground edge in 2D (the genuine flyover)', () => {
    // Gate (C): prove a real over/under. A side-viaduct (the deck running
    // ALONGSIDE the ground without crossing) passes the "layers distinct" test
    // above but FAILS here — there is no layer-1 edge whose 2D segment strictly
    // crosses a layer-0 edge's segment. The search is generic over compiled edges
    // (not pinned to specific ids) so the assertion survives id renames.
    //
    // At least one grade-separated crossing exists — the deck rides OVER the
    // ground. (Different layers, so this 2D crossing is overlap-free by
    // construction; see the same-layer overlap assertion below.)
    expect(gradeSeparatedCrossings().length).toBeGreaterThanOrEqual(1);
  });

  it('has ZERO same-layer footprint overlaps (no red overlap banner)', () => {
    // The "clean" bar: every layer-1-over-layer-0 crossing is grade-separated, and
    // no two SAME-layer pieces share a footprint without a join. The detector must
    // find nothing — no exemptions.
    expect([...detectSameLayerOverlaps(demo.pieces)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Upper station reachable ONLY via the divert legs
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — upper station gated by divert', () => {
  it('removing the divert adjacencies disconnects the upper station', () => {
    // Cut BOTH directed edges of every divert adjacency (the two junction-branch
    // legs). A directed-only cut would leave the reverse (ramp → junction) intact
    // and keep the deck connected — a phantom pass.
    const cut = new Set<string>();
    for (const e of layout.edges) {
      if (e.requires_switch_state === 'divert') {
        cut.add(`${e.from_marker_id}|${e.to_marker_id}`);
        cut.add(`${e.to_marker_id}|${e.from_marker_id}`);
      }
    }
    expect(cut.size).toBeGreaterThan(0);
    const adj = buildAdjacency(layout, cut);
    const groundStartA = demo.groundStations[0];
    expect(groundStartA).toBeDefined();
    if (groundStartA === undefined) return;
    const seen = reachable(adj, groundStartA);
    // The ground loop stays connected; the deck (upper station) is isolated.
    expect(seen.has(groundStartA)).toBe(true);
    expect(seen.has(demo.upperStation)).toBe(false);
  });

  it('the upper station IS reachable on the full graph (sanity)', () => {
    const adj = buildAdjacency(layout);
    const groundStartA = demo.groundStations[0];
    if (groundStartA === undefined) return;
    expect(reachable(adj, groundStartA).has(demo.upperStation)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// J2 merge is PASSIVE: the trunk-exit path carries no switch constraint
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — J2 passive merge', () => {
  it('J2 has exactly one switch-unconstrained outbound edge (its trunk exit), which both trains traverse', () => {
    // J2's marker id: the other junction (not J1).
    const junctionMarkers = layout.junctions.map((j) => j.marker_id);
    expect(junctionMarkers).toContain(demo.junctionId);
    const j2 = junctionMarkers.find((id) => id !== demo.junctionId);
    expect(j2).toBeDefined();
    if (j2 === undefined) return;
    const j2Out = layout.edges.filter((e) => e.from_marker_id === j2);
    const unconstrained = j2Out.filter((e) => e.requires_switch_state === undefined);
    // The trunk (endpoint 0) is the sole switch-free outbound — the path BOTH
    // trains take when leaving J2 (they enter via through/branch, leave via trunk).
    expect(unconstrained.length).toBe(1);
    // The constrained outbounds are exactly the main + divert legs (never traversed
    // on the way OUT — trains arrive on them and leave via the trunk).
    const constrained = new Set(
      j2Out.map((e) => e.requires_switch_state).filter((s) => s !== undefined),
    );
    expect(constrained.has('main')).toBe(true);
    expect(constrained.has('divert')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge lengths stay above the length-aware tail-release floor
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — edge lengths', () => {
  it('every edge is longer than the 60mm train length (switched-junction serialisation precondition)', () => {
    for (const e of layout.edges) {
      expect(e.estimated_length_mm ?? 0).toBeGreaterThan(60);
    }
  });
});

// ---------------------------------------------------------------------------
// Trains are device pieces — contribute no markers
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — trains', () => {
  it('train device pieces contribute no markers', () => {
    expect(layout.markers.some((m) => m.id === 'M-trainA')).toBe(false);
    expect(layout.markers.some((m) => m.id === 'M-trainB')).toBe(false);
  });

  it('exposes stable device ids and a complete liveIds set', () => {
    expect(demo.trainAId).toBe('T-trainA');
    expect(demo.trainBId).toBe('T-trainB');
    expect(new Set(demo.liveIds)).toEqual(new Set(demo.pieces.map((p) => p.id)));
  });

  it('the two trains start at distinct ground-station markers', () => {
    expect(demo.groundStations.length).toBe(2);
    expect(demo.groundStations[0]).not.toBe(demo.groundStations[1]);
  });
});
