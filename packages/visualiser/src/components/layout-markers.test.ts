import { describe, expect, it } from 'vitest';
import topology from './__fixtures__/inferred-topology.json';
import { type Point, layoutMarkers } from './layout-markers.js';

/*
 * Part 5 — a deterministic readable layout. The headline metric: edge crossings
 * on the inferred topology of test-track-layout.json must drop materially versus
 * the old "circle in marker-array order" fallback.
 */

interface Marker {
  readonly id: string;
}
interface Edge {
  readonly from_marker_id: string;
  readonly to_marker_id: string;
}

const MARKERS = topology.markers as Marker[];
const EDGES = topology.edges as Edge[];

/* Unique undirected edges with distinct endpoints. */
function undirectedEdges(edges: ReadonlyArray<Edge>): Array<[string, string]> {
  const uniq = new Map<string, [string, string]>();
  for (const e of edges) {
    if (e.from_marker_id === e.to_marker_id) continue;
    const key = [e.from_marker_id, e.to_marker_id].sort().join('|');
    uniq.set(key, [e.from_marker_id, e.to_marker_id]);
  }
  return [...uniq.values()];
}

/* Do segments p1p2 and p3p4 properly cross (not merely touch at a shared end)? */
function properlyIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o = (a: Point, b: Point, c: Point) =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const o1 = o(p1, p2, p3);
  const o2 = o(p1, p2, p4);
  const o3 = o(p3, p4, p1);
  const o4 = o(p3, p4, p2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

function countCrossings(pos: ReadonlyMap<string, Point>, edges: ReadonlyArray<Edge>): number {
  const list = undirectedEdges(edges).filter(([a, b]) => pos.has(a) && pos.has(b));
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const e1 = list[i];
      const e2 = list[j];
      if (e1 === undefined || e2 === undefined) continue;
      const [a, b] = e1;
      const [c, d] = e2;
      if (a === c || a === d || b === c || b === d) continue; // adjacent edges
      const pa = pos.get(a);
      const pb = pos.get(b);
      const pc = pos.get(c);
      const pd = pos.get(d);
      if (pa && pb && pc && pd && properlyIntersect(pa, pb, pc, pd)) n++;
    }
  }
  return n;
}

/* The old fallback: evenly spaced around one circle, in marker-array order. */
function circularLayout(markers: ReadonlyArray<Marker>): Map<string, Point> {
  const out = new Map<string, Point>();
  const n = markers.length;
  markers.forEach((m, i) => {
    const a = (i / Math.max(n, 1)) * Math.PI * 2;
    out.set(m.id, { x: Math.cos(a) * 100, y: Math.sin(a) * 100 });
  });
  return out;
}

describe('layoutMarkers — readable inferred-topology layout', () => {
  it('materially reduces edge crossings vs the circular fallback', () => {
    const before = countCrossings(circularLayout(MARKERS), EDGES);
    const after = countCrossings(layoutMarkers(MARKERS, EDGES), EDGES);
    expect(before, 'circular baseline has crossings to beat').toBeGreaterThan(0);
    expect(after, `crossings ${before} → ${after}`).toBeLessThanOrEqual(Math.floor(before / 2));
  });

  it('is deterministic — identical output across runs', () => {
    const a = layoutMarkers(MARKERS, EDGES);
    const b = layoutMarkers(MARKERS, EDGES);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('is insensitive to directed-edge input order (undirected collapse)', () => {
    const reversed = [...EDGES].reverse().map((e) => ({
      from_marker_id: e.to_marker_id,
      to_marker_id: e.from_marker_id,
    }));
    const a = layoutMarkers(MARKERS, EDGES);
    const b = layoutMarkers(MARKERS, reversed);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('separates a disconnected orphan into its own band (no inter-component crossing)', () => {
    // A triangle loop + a degree-3 junction with three 2-node legs + an orphan.
    const markers: Marker[] = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' }, // triangle a-b-c
      { id: 'J' }, // junction
      { id: 'l1' },
      { id: 'l2' },
      { id: 'l3' }, // three legs off J
      { id: 'orphan' },
    ];
    const edges: Edge[] = [
      { from_marker_id: 'a', to_marker_id: 'b' },
      { from_marker_id: 'b', to_marker_id: 'c' },
      { from_marker_id: 'c', to_marker_id: 'a' },
      { from_marker_id: 'J', to_marker_id: 'l1' },
      { from_marker_id: 'J', to_marker_id: 'l2' },
      { from_marker_id: 'J', to_marker_id: 'l3' },
    ];
    const pos = layoutMarkers(markers, edges);
    const orphan = pos.get('orphan');
    expect(orphan).toBeDefined();
    // The orphan sits in a band to the right of every connected node (disjoint x).
    const connectedMaxX = Math.max(
      ...['a', 'b', 'c', 'J', 'l1', 'l2', 'l3'].map((id) => pos.get(id)?.x ?? 0),
    );
    expect(orphan?.x ?? 0).toBeGreaterThan(connectedMaxX);
  });

  it("splays a junction's legs to distinct angles (>= 20 degrees apart)", () => {
    const markers: Marker[] = [{ id: 'J' }, { id: 'l1' }, { id: 'l2' }, { id: 'l3' }];
    const edges: Edge[] = [
      { from_marker_id: 'J', to_marker_id: 'l1' },
      { from_marker_id: 'J', to_marker_id: 'l2' },
      { from_marker_id: 'J', to_marker_id: 'l3' },
    ];
    const pos = layoutMarkers(markers, edges);
    const j = pos.get('J');
    if (j === undefined) throw new Error('no junction');
    const angles = ['l1', 'l2', 'l3']
      .map((id) => pos.get(id))
      .filter((p): p is Point => p !== undefined)
      .map((p) => Math.atan2(p.y - j.y, p.x - j.x))
      .sort((x, y) => x - y);
    for (let i = 0; i < angles.length; i++) {
      const cur = angles[i] ?? 0;
      const next = angles[(i + 1) % angles.length] ?? 0;
      const gap = (next - cur + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
      expect(gap, 'leg separation').toBeGreaterThanOrEqual((20 * Math.PI) / 180 - 1e-9);
    }
  });
});
