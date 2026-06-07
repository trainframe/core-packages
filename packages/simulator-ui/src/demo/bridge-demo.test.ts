import { describe, expect, it } from 'vitest';
import { compileLayout } from '../track/layout-from-pieces.js';
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
// 2D segment-crossing helpers (for the over/under bridge proof)
// ---------------------------------------------------------------------------

interface Seg {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

/** The 2D segment for an edge: its two pieces' centres. */
function edgeSeg(e: Edge): Seg | undefined {
  const a = pieceByMarker.get(e.from_marker_id);
  const b = pieceByMarker.get(e.to_marker_id);
  if (a === undefined || b === undefined) return undefined;
  return { ax: a.position.x, ay: a.position.y, bx: b.position.x, by: b.position.y };
}

/** True when segments p and q properly cross (strict, so shared-endpoint
 * touches don't count). Standard orientation test. */
function segmentsCross(p: Seg, q: Seg): boolean {
  const o = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
    (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  const d1 = o(q.ax, q.ay, q.bx, q.by, p.ax, p.ay);
  const d2 = o(q.ax, q.ay, q.bx, q.by, p.bx, p.by);
  const d3 = o(p.ax, p.ay, p.bx, p.by, q.ax, q.ay);
  const d4 = o(p.ax, p.ay, p.bx, p.by, q.bx, q.by);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True when two edges share any marker. */
function edgesShareMarker(p: Edge, q: Edge): boolean {
  return (
    p.from_marker_id === q.from_marker_id ||
    p.from_marker_id === q.to_marker_id ||
    p.to_marker_id === q.from_marker_id ||
    p.to_marker_id === q.to_marker_id
  );
}

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
// Over/under bridge — the discriminating test
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — over/under bridge', () => {
  it('a layer-1 deck edge crosses a layer-0 main-loop edge in 2D, sharing no marker', () => {
    const deckEdges = layout.edges.filter(isLayer1DeckEdge);
    const groundEdges = layout.edges.filter(isMainGroundEdge);
    expect(deckEdges.length).toBeGreaterThan(0);
    expect(groundEdges.length).toBeGreaterThan(0);
    const crossing = deckEdges.some((deck) =>
      groundEdges.some((ground) => {
        if (edgesShareMarker(deck, ground)) return false;
        const ds = edgeSeg(deck);
        const gs = edgeSeg(ground);
        return ds !== undefined && gs !== undefined && segmentsCross(ds, gs);
      }),
    );
    expect(crossing).toBe(true);
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
