import { describe, expect, it } from 'vitest';
import { compileLayout } from './layout-from-pieces.js';
import type { RotationDeg, TrackPiece } from './pieces.js';

let nextId = 0;
function pid(): string {
  return `p${nextId++}`;
}

function piece(
  type: TrackPiece['type'],
  x = 0,
  y = 0,
  rotationDeg: RotationDeg = 0,
  tagged = false,
): TrackPiece {
  return { id: pid(), type, position: { x, y }, rotationDeg, tagged };
}

beforeEach(() => {
  nextId = 0;
});

describe('compileLayout — single piece', () => {
  it('a single straight produces 2 markers and 1 edge', () => {
    const layout = compileLayout([piece('straight')], 'test');
    expect(layout.markers).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
    expect(layout.junctions).toHaveLength(0);
    expect(layout.name).toBe('test');
  });

  it('a single curve produces 2 markers and 1 edge', () => {
    const layout = compileLayout([piece('curve')], 'test');
    expect(layout.markers).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
  });

  it('a single station produces 2 markers and 1 edge with length 220', () => {
    const layout = compileLayout([piece('station')], 'test');
    expect(layout.markers).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.estimated_length_mm).toBe(220);
  });

  it('a single junction produces 3 markers, 2 edges, and 1 junction entry', () => {
    const layout = compileLayout([piece('junction')], 'test');
    expect(layout.markers).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
    expect(layout.junctions).toHaveLength(1);
  });

  it('junction edges have correct switch states', () => {
    const layout = compileLayout([piece('junction')], 'test');
    const mainEdge = layout.edges.find((e) => e.requires_switch_state === 'main');
    const divertEdge = layout.edges.find((e) => e.requires_switch_state === 'divert');
    expect(mainEdge).toBeDefined();
    expect(divertEdge).toBeDefined();
  });

  it('junction entry has valid_positions = [main, divert]', () => {
    const layout = compileLayout([piece('junction')], 'test');
    expect(layout.junctions[0]?.valid_positions).toEqual(['main', 'divert']);
  });

  it('junction trunk marker has kind = junction', () => {
    const layout = compileLayout([piece('junction')], 'test');
    const j = layout.junctions[0];
    const trunkMarker = layout.markers.find((m) => m.id === j?.marker_id);
    expect(trunkMarker?.kind).toBe('junction');
  });

  it('a single terminus produces 2 markers and 1 edge with length 60', () => {
    const layout = compileLayout([piece('terminus')], 'test');
    expect(layout.markers).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]?.estimated_length_mm).toBe(60);
  });

  it('terminus dead-end marker has kind = terminus', () => {
    const layout = compileLayout([piece('terminus')], 'test');
    // The dead-end marker is the one NOT referenced by the open endpoint (which
    // connects from the east end). It's the to_marker_id.
    const toId = layout.edges[0]?.to_marker_id;
    const dead = layout.markers.find((m) => m.id === toId);
    expect(dead?.kind).toBe('terminus');
  });

  it('a single crossing produces 4 markers and 2 edges', () => {
    const layout = compileLayout([piece('crossing')], 'test');
    expect(layout.markers).toHaveLength(4);
    expect(layout.edges).toHaveLength(2);
  });

  it('empty piece array produces empty layout', () => {
    const layout = compileLayout([], 'empty');
    expect(layout.markers).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.junctions).toHaveLength(0);
  });
});

describe('compileLayout — clustering', () => {
  it('two adjacent straights share one marker (3 markers total, 2 edges)', () => {
    // Straight A at x=0: exit at (100, 0)
    // Straight B at x=200: entry at (100, 0) — exactly on top, distance 0
    const a = piece('straight', 0, 0);
    const b = piece('straight', 200, 0);
    const layout = compileLayout([a, b], 'two-straights');
    // A has endpoints at (-100,0) and (100,0)
    // B has endpoints at (100,0) and (300,0)
    // (100,0) from A and (100,0) from B cluster together
    expect(layout.markers).toHaveLength(3);
    expect(layout.edges).toHaveLength(2);
  });

  it('two adjacent straights share the correct centre marker', () => {
    const a = piece('straight', 0, 0);
    const b = piece('straight', 200, 0);
    const layout = compileLayout([a, b], 'adj');
    // The shared marker should be the one referenced by both edges
    const fromIds = layout.edges.map((e) => e.from_marker_id);
    const toIds = layout.edges.map((e) => e.to_marker_id);
    const shared = layout.markers.find(
      (m) =>
        (fromIds.includes(m.id) || toIds.includes(m.id)) &&
        fromIds.filter((id) => id === m.id).length + toIds.filter((id) => id === m.id).length >= 2,
    );
    expect(shared).toBeDefined();
  });

  it('endpoints within SNAP_DISTANCE_MM cluster even if not exact', () => {
    // Put second straight slightly off (20 mm gap < 30 mm snap)
    const a = piece('straight', 0, 0);
    const b = piece('straight', 220, 0); // 20 mm gap between A's exit (100) and B's entry (110)
    const layout = compileLayout([a, b], 'near');
    expect(layout.markers).toHaveLength(3);
  });

  it('endpoints beyond SNAP_DISTANCE_MM do NOT cluster', () => {
    // 40 mm gap > 30 mm snap
    const a = piece('straight', 0, 0);
    const b = piece('straight', 240, 0);
    const layout = compileLayout([a, b], 'far');
    expect(layout.markers).toHaveLength(4);
  });

  it('isolated piece (no neighbours) produces isolated markers', () => {
    const a = piece('straight', 0, 0);
    const b = piece('straight', 1000, 0); // far away
    const layout = compileLayout([a, b], 'isolated');
    expect(layout.markers).toHaveLength(4);
    expect(layout.edges).toHaveLength(2);
    // No marker shared between the two edges
    const [edgeA, edgeB] = layout.edges;
    expect(edgeA).toBeDefined();
    expect(edgeB).toBeDefined();
    if (edgeA === undefined || edgeB === undefined) return;
    const aIds = new Set([edgeA.from_marker_id, edgeA.to_marker_id]);
    const bIds = new Set([edgeB.from_marker_id, edgeB.to_marker_id]);
    expect([...aIds].some((id) => bIds.has(id))).toBe(false);
  });
});

describe('compileLayout — marker kinds', () => {
  it('station exit marker has kind station_stop', () => {
    const layout = compileLayout([piece('station')], 'st');
    // exit (ei=1) → station_stop
    const toId = layout.edges[0]?.to_marker_id;
    const exitMarker = layout.markers.find((m) => m.id === toId);
    expect(exitMarker?.kind).toBe('station_stop');
  });

  it('crossing markers all have kind block_boundary', () => {
    const layout = compileLayout([piece('crossing')], 'cr');
    for (const m of layout.markers) {
      expect(m.kind).toBe('block_boundary');
    }
  });
});

describe('compileLayout — marker IDs', () => {
  it('marker IDs are sequential m1, m2, …', () => {
    const layout = compileLayout([piece('straight')], 'seq');
    const ids = layout.markers.map((m) => m.id).sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('edge marker references resolve to existing markers', () => {
    const layout = compileLayout([piece('junction')], 'junc');
    const markerIdSet = new Set(layout.markers.map((m) => m.id));
    for (const edge of layout.edges) {
      expect(markerIdSet.has(edge.from_marker_id)).toBe(true);
      expect(markerIdSet.has(edge.to_marker_id)).toBe(true);
    }
    for (const j of layout.junctions) {
      expect(markerIdSet.has(j.marker_id)).toBe(true);
    }
  });
});
