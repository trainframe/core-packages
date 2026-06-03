import { beforeEach, describe, expect, it } from 'vitest';
import { compileLayout } from './layout-from-pieces.js';
import { type RotationDeg, type TrackPiece, getEndpoints } from './pieces.js';

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

// ---------------------------------------------------------------------------
// Per-piece markers — the central contract of the new compiler. The scan flow
// in ToyTable emits `tag_assignment` with tag_id = `M-{piece.id}`; the private
// compiler must produce markers with the same ids so the server's view of the
// world and the in-browser sim's view of the world agree.
// ---------------------------------------------------------------------------

describe('compileLayout — single piece, per-piece markers', () => {
  it('a single straight produces 1 marker (M-{piece.id}) and 0 edges', () => {
    const p = piece('straight');
    const layout = compileLayout([p], 'test');
    expect(layout.markers).toHaveLength(1);
    expect(layout.markers[0]?.id).toBe(`M-${p.id}`);
    expect(layout.markers[0]?.kind).toBe('block_boundary');
    expect(layout.edges).toHaveLength(0);
    expect(layout.junctions).toHaveLength(0);
    expect(layout.name).toBe('test');
  });

  it('a single curve produces 1 marker (block_boundary) and 0 edges', () => {
    const p = piece('curve');
    const layout = compileLayout([p], 'test');
    expect(layout.markers).toHaveLength(1);
    expect(layout.markers[0]?.id).toBe(`M-${p.id}`);
    expect(layout.markers[0]?.kind).toBe('block_boundary');
    expect(layout.edges).toHaveLength(0);
  });

  it('a single station produces 1 marker (station_stop) and 0 edges', () => {
    const p = piece('station');
    const layout = compileLayout([p], 'test');
    expect(layout.markers).toHaveLength(1);
    expect(layout.markers[0]?.id).toBe(`M-${p.id}`);
    expect(layout.markers[0]?.kind).toBe('station_stop');
    expect(layout.edges).toHaveLength(0);
  });

  it('a single junction produces 1 marker (junction), 0 edges, 1 junction entry', () => {
    const p = piece('junction');
    const layout = compileLayout([p], 'test');
    expect(layout.markers).toHaveLength(1);
    expect(layout.markers[0]?.id).toBe(`M-${p.id}`);
    expect(layout.markers[0]?.kind).toBe('junction');
    expect(layout.edges).toHaveLength(0);
    expect(layout.junctions).toHaveLength(1);
    expect(layout.junctions[0]?.marker_id).toBe(`M-${p.id}`);
    expect(layout.junctions[0]?.valid_positions).toEqual(['main', 'divert']);
  });

  it('a single terminus produces 1 marker (terminus) and 0 edges', () => {
    const p = piece('terminus');
    const layout = compileLayout([p], 'test');
    expect(layout.markers).toHaveLength(1);
    expect(layout.markers[0]?.id).toBe(`M-${p.id}`);
    expect(layout.markers[0]?.kind).toBe('terminus');
    expect(layout.edges).toHaveLength(0);
  });

  it('a single crossing produces 1 marker (block_boundary) and 0 edges', () => {
    const p = piece('crossing');
    const layout = compileLayout([p], 'test');
    expect(layout.markers).toHaveLength(1);
    expect(layout.markers[0]?.id).toBe(`M-${p.id}`);
    expect(layout.markers[0]?.kind).toBe('block_boundary');
    expect(layout.edges).toHaveLength(0);
  });

  it('empty piece array produces empty layout', () => {
    const layout = compileLayout([], 'empty');
    expect(layout.markers).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.junctions).toHaveLength(0);
  });

  it('device pieces (train, gate) contribute no markers and no edges', () => {
    const train = piece('train', 50, 50);
    const gate = piece('gate', 60, 60);
    const layout = compileLayout([train, gate], 'devices-only');
    expect(layout.markers).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adjacency → bidirectional edges between piece markers
// ---------------------------------------------------------------------------

describe('compileLayout — adjacency emits bidirectional edges', () => {
  it('two adjacent straights produce 2 markers and 2 edges (both directions)', () => {
    // A at x=0 has endpoint at (100,0); B at x=200 has endpoint at (100,0).
    const a = piece('straight', 0, 0);
    const b = piece('straight', 200, 0);
    const layout = compileLayout([a, b], 'two-straights');
    expect(layout.markers).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
    const ids = layout.markers.map((m) => m.id).sort();
    expect(ids).toEqual([`M-${a.id}`, `M-${b.id}`].sort());

    const aToB = layout.edges.find(
      (e) => e.from_marker_id === `M-${a.id}` && e.to_marker_id === `M-${b.id}`,
    );
    const bToA = layout.edges.find(
      (e) => e.from_marker_id === `M-${b.id}` && e.to_marker_id === `M-${a.id}`,
    );
    expect(aToB).toBeDefined();
    expect(bToA).toBeDefined();
  });

  it('edge length is the Euclidean centre-to-centre distance, rounded', () => {
    const a = piece('straight', 0, 0);
    const b = piece('straight', 200, 0);
    const layout = compileLayout([a, b], 'len');
    for (const edge of layout.edges) {
      expect(edge.estimated_length_mm).toBe(200);
    }
  });

  it('endpoints within SNAP_DISTANCE_MM count as adjacent (edges emitted)', () => {
    // 20 mm gap < 30 mm snap
    const a = piece('straight', 0, 0);
    const b = piece('straight', 220, 0);
    const layout = compileLayout([a, b], 'near');
    expect(layout.edges).toHaveLength(2);
  });

  it('endpoints beyond SNAP_DISTANCE_MM do NOT count as adjacent (no edges)', () => {
    // 40 mm gap > 30 mm snap
    const a = piece('straight', 0, 0);
    const b = piece('straight', 240, 0);
    const layout = compileLayout([a, b], 'far');
    expect(layout.markers).toHaveLength(2);
    expect(layout.edges).toHaveLength(0);
  });

  it('isolated pieces produce markers without edges between them', () => {
    const a = piece('straight', 0, 0);
    const b = piece('straight', 1000, 0); // far away
    const layout = compileLayout([a, b], 'isolated');
    expect(layout.markers).toHaveLength(2);
    expect(layout.edges).toHaveLength(0);
  });

  it('three straights in a line produce 4 edges (two adjacencies × 2 directions)', () => {
    const a = piece('straight', 0, 0);
    const b = piece('straight', 200, 0);
    const c = piece('straight', 400, 0);
    const layout = compileLayout([a, b, c], 'three');
    expect(layout.markers).toHaveLength(3);
    expect(layout.edges).toHaveLength(4);
  });

  it('marker positions sit at piece centres, not at endpoint centroids', () => {
    const a = piece('straight', 50, 75);
    const layout = compileLayout([a], 'pos');
    expect(layout.markers[0]?.position).toEqual({ x_mm: 50, y_mm: 75 });
  });
});

// ---------------------------------------------------------------------------
// Junction switch states are tagged on outbound edges only
// ---------------------------------------------------------------------------

describe('compileLayout — junctions and switch states', () => {
  it('junction with trunk + main + divert neighbours: outbound edges carry switch state', () => {
    // Place a junction at origin. Its endpoints (rotation 0):
    //   ep 0 (trunk):  (-100, 0)  angle 180°
    //   ep 1 (main):   ( 100, 0)  angle   0°
    //   ep 2 (divert): ( cos45*100, -sin45*100 ) angle 45°
    const j = piece('junction', 0, 0);
    // Read the junction's branch endpoint to place the divert neighbour
    // without having to redo the rotation math.
    const eps = getEndpoints(j);
    const trunkEp = eps[0];
    const mainEp = eps[1];
    const branchEp = eps[2];
    expect(trunkEp).toBeDefined();
    expect(mainEp).toBeDefined();
    expect(branchEp).toBeDefined();
    if (trunkEp === undefined || mainEp === undefined || branchEp === undefined) return;

    // Each neighbour is a straight placed so its endpoint 0 (at local (-100,0))
    // lands on the junction's endpoint. Rotation 0 means endpoint 0 is at
    // (centre.x - 100, centre.y), so centre = endpoint + (100, 0).
    const trunkNbr = piece('straight', trunkEp.x + 100, trunkEp.y);
    const mainNbr = piece('straight', mainEp.x + 100, mainEp.y);
    const divertNbr = piece('straight', branchEp.x + 100, branchEp.y);
    const layout = compileLayout([j, trunkNbr, mainNbr, divertNbr], 'fan');

    const jId = `M-${j.id}`;
    const jToMain = layout.edges.find(
      (e) => e.from_marker_id === jId && e.to_marker_id === `M-${mainNbr.id}`,
    );
    const jToDivert = layout.edges.find(
      (e) => e.from_marker_id === jId && e.to_marker_id === `M-${divertNbr.id}`,
    );
    const jToTrunk = layout.edges.find(
      (e) => e.from_marker_id === jId && e.to_marker_id === `M-${trunkNbr.id}`,
    );
    expect(jToMain?.requires_switch_state).toBe('main');
    expect(jToDivert?.requires_switch_state).toBe('divert');
    // Trunk has no switch constraint — always reachable.
    expect(jToTrunk?.requires_switch_state).toBeUndefined();
  });

  it('inbound edges (neighbour → junction marker) carry no switch state', () => {
    const j = piece('junction', 0, 0);
    const eps = getEndpoints(j);
    const mainEp = eps[1];
    expect(mainEp).toBeDefined();
    if (mainEp === undefined) return;
    const mainNbr = piece('straight', mainEp.x + 100, mainEp.y);
    const layout = compileLayout([j, mainNbr], 'junction-main');
    const inbound = layout.edges.find(
      (e) => e.from_marker_id === `M-${mainNbr.id}` && e.to_marker_id === `M-${j.id}`,
    );
    expect(inbound).toBeDefined();
    expect(inbound?.requires_switch_state).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Terminus pieces are dead-ends — inbound only, no outbound
// ---------------------------------------------------------------------------

describe('compileLayout — terminus is a dead-end', () => {
  it('a terminus adjacent to a straight has an inbound edge but no outbound', () => {
    // Terminus open endpoint sits at local (30, 0) — when placed at x=0 it's
    // at (30, 0). Place a straight whose endpoint 0 (local (-100, 0)) lands
    // on the terminus' open endpoint at (30, 0): straight centre at (130, 0).
    const t = piece('terminus', 0, 0);
    const s = piece('straight', 130, 0);
    const layout = compileLayout([t, s], 'dead-end');
    expect(layout.markers).toHaveLength(2);
    // Only one edge: straight → terminus.
    expect(layout.edges).toHaveLength(1);
    const edge = layout.edges[0];
    expect(edge?.from_marker_id).toBe(`M-${s.id}`);
    expect(edge?.to_marker_id).toBe(`M-${t.id}`);
  });
});

// ---------------------------------------------------------------------------
// Crossings — one marker, edges to all adjacent neighbours
// ---------------------------------------------------------------------------

describe('compileLayout — crossings', () => {
  it('a crossing with one neighbour gets bidirectional edges to that neighbour', () => {
    // Crossing at origin has endpoints at (100,0), (0,-100), (-100,0), (0,100).
    // Place a straight on the east side: endpoint 0 (-100,0 local) should
    // land on the crossing's east endpoint (100,0). Centre at (200, 0).
    const c = piece('crossing', 0, 0);
    const east = piece('straight', 200, 0);
    const layout = compileLayout([c, east], 'cross');
    expect(layout.markers).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
    expect(layout.markers.find((m) => m.id === `M-${c.id}`)?.kind).toBe('block_boundary');
  });
});
