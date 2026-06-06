import { describe, expect, it } from 'vitest';
import { compileLayout } from '../track/layout-from-pieces.js';
import { getEndpoints, layerOf } from '../track/pieces.js';
import { buildBridgeDemo } from './bridge-demo.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Layout = ReturnType<typeof compileLayout>;

/** Markers in `layout` whose id begins `M-{prefix}` (loop partition by id). */
function markersWithPrefix(layout: Layout, prefix: string): string[] {
  return layout.markers.map((m) => m.id).filter((id) => id.startsWith(`M-${prefix}`));
}

function inboundCount(layout: Layout, markerId: string): number {
  return layout.edges.filter((e) => e.to_marker_id === markerId).length;
}
function outboundCount(layout: Layout, markerId: string): number {
  return layout.edges.filter((e) => e.from_marker_id === markerId).length;
}

/** The set of distinct neighbour markers of `markerId` (via any edge, either
 * direction). In a single simple cycle every node has exactly two neighbours —
 * the discriminating proof of "closed loop, no dead ends, no junctions"
 * (`≥1 in/out` alone is satisfied by any connected piece, since edges are
 * emitted bidirectionally). */
function neighbours(layout: Layout, markerId: string): Set<string> {
  const ns = new Set<string>();
  for (const e of layout.edges) {
    if (e.from_marker_id === markerId) ns.add(e.to_marker_id);
    if (e.to_marker_id === markerId) ns.add(e.from_marker_id);
  }
  return ns;
}

interface Seg {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
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

const demo = buildBridgeDemo();
const layout = compileLayout(demo.pieces, 'bridge-demo');

/** Map marker id → its piece (track pieces only). */
const pieceByMarker = new Map<string, (typeof demo.pieces)[number]>(
  demo.pieces.filter((p) => p.type !== 'train').map((p) => [`M-${p.id}`, p] as const),
);

type Edge = (typeof layout.edges)[number];

/** The 2D segment for an edge: its two pieces' centres. */
function edgeSeg(from: string, to: string): Seg | undefined {
  const a = pieceByMarker.get(from);
  const b = pieceByMarker.get(to);
  if (a === undefined || b === undefined) return undefined;
  return { ax: a.position.x, ay: a.position.y, bx: b.position.x, by: b.position.y };
}

/** True when both endpoints of the edge are layer-1 pieces (a deck edge). */
function isLayer1DeckEdge(e: Edge): boolean {
  const a = pieceByMarker.get(e.from_marker_id);
  const b = pieceByMarker.get(e.to_marker_id);
  return a !== undefined && b !== undefined && layerOf(a) === 1 && layerOf(b) === 1;
}

/** True when both edge endpoints are loop-B ground markers. */
function isGroundBEdge(e: Edge): boolean {
  return e.from_marker_id.startsWith('M-lb') && e.to_marker_id.startsWith('M-lb');
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

/** True when a deck edge's 2D segment properly crosses a ground edge's, sharing
 * no marker — a true over-crossing (bridge), not a merge. */
function crossesAsBridge(deck: Edge, ground: Edge): boolean {
  if (edgesShareMarker(deck, ground)) return false;
  const ds = edgeSeg(deck.from_marker_id, deck.to_marker_id);
  const gs = edgeSeg(ground.from_marker_id, ground.to_marker_id);
  if (ds === undefined || gs === undefined) return false;
  return segmentsCross(ds, gs);
}

// ---------------------------------------------------------------------------
// Both loops compile to CLOSED cycles
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — closed loops', () => {
  it('every loop-B track marker has at least one inbound and one outbound edge', () => {
    const bMarkers = markersWithPrefix(layout, 'lb');
    expect(bMarkers.length).toBeGreaterThan(0);
    for (const m of bMarkers) {
      expect(inboundCount(layout, m), `${m} inbound`).toBeGreaterThanOrEqual(1);
      expect(outboundCount(layout, m), `${m} outbound`).toBeGreaterThanOrEqual(1);
    }
  });

  it('every loop-A track marker has at least one inbound and one outbound edge', () => {
    const aMarkers = markersWithPrefix(layout, 'la');
    expect(aMarkers.length).toBeGreaterThan(0);
    for (const m of aMarkers) {
      expect(inboundCount(layout, m), `${m} inbound`).toBeGreaterThanOrEqual(1);
      expect(outboundCount(layout, m), `${m} outbound`).toBeGreaterThanOrEqual(1);
    }
  });

  it('every loop-B track marker has exactly two distinct neighbours (a simple cycle)', () => {
    for (const m of markersWithPrefix(layout, 'lb')) {
      expect(neighbours(layout, m).size, `${m} neighbours`).toBe(2);
    }
  });

  it('every loop-A track marker has exactly two distinct neighbours (a simple cycle)', () => {
    for (const m of markersWithPrefix(layout, 'la')) {
      expect(neighbours(layout, m).size, `${m} neighbours`).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Disjoint loops — no edge bridges loop A to loop B
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — disjoint loops', () => {
  it('no edge connects a loop-A marker to a loop-B marker', () => {
    for (const e of layout.edges) {
      const aToB = e.from_marker_id.startsWith('M-la') && e.to_marker_id.startsWith('M-lb');
      const bToA = e.from_marker_id.startsWith('M-lb') && e.to_marker_id.startsWith('M-la');
      expect(aToB || bToA, `${e.from_marker_id} -> ${e.to_marker_id}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Loop A structure: ramps, upper station, a layer-1 deck edge
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — loop A deck', () => {
  it('has both ramp markers and the upper station marker', () => {
    const ids = layout.markers.map((m) => m.id);
    expect(ids).toContain('M-la-rampUp');
    expect(ids).toContain('M-la-rampDown');
    expect(ids).toContain('M-la-deckSt');
  });

  it('has a deck edge between two layer-1 pieces', () => {
    expect(layout.edges.find(isLayer1DeckEdge)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Over-crossing — the discriminating test
// ---------------------------------------------------------------------------

describe('buildBridgeDemo — bridge over-crossing', () => {
  it('a layer-1 deck edge crosses a layer-0 loop-B edge in 2D, sharing no marker', () => {
    const deckEdges = layout.edges.filter(isLayer1DeckEdge);
    const groundBEdges = layout.edges.filter(isGroundBEdge);
    const crossing = deckEdges.some((deck) =>
      groundBEdges.some((ground) => crossesAsBridge(deck, ground)),
    );
    expect(crossing, 'expected a layer-1 deck edge crossing a layer-0 loop-B edge').toBe(true);
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
    // Every piece id (track + trains) is live.
    expect(new Set(demo.liveIds)).toEqual(new Set(demo.pieces.map((p) => p.id)));
  });
});
