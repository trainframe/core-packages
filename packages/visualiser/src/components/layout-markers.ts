/**
 * Deterministic readable layout for an inferred topology that has NO spatial
 * coordinates (Part 5). Replaces the old "evenly spaced around a circle, in
 * marker-array order" fallback — which made every edge cut across the disc — with
 * a stress-majorisation (SMACOF) layout that places graph-adjacent markers near
 * each other, so loops render as polygons and junction legs splay apart.
 *
 * Pure and deterministic: NO `Math.random`, NO `Date.now`. A fixed circular seed
 * + a fixed iteration count means the same graph always yields the same layout
 * (headless-testable, and reusable verbatim by the e-paper frontend). Each
 * connected component is laid out independently and packed into its own
 * horizontal band, so the orphan marker (and a detached train) sit clear of the
 * network and no edge can cross between components.
 *
 * Algorithm (chosen by a design judge-panel over force-directed / SMACOF /
 * structure-aware candidates):
 *  1. collapse directed A→B / B→A edges into one undirected graph;
 *  2. split into connected components (BFS, input order);
 *  3. per component: all-pairs hop distances (BFS), a circular seed, then
 *     SMACOF Gauss–Seidel sweeps driving each pair's geometric distance toward
 *     its hop distance — adjacency becomes proximity;
 *  4. fan a junction's legs apart if SMACOF left two within MIN_LEG_SEP;
 *  5. normalise each component to a unit box and pack left-to-right.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

interface MarkerLike {
  readonly id: string;
}
interface EdgeLike {
  readonly from_marker_id: string;
  readonly to_marker_id: string;
}

/* Locked constants — fixed for determinism (no seed RNG needed). */
const ITERATIONS = 300;
const EPS = 1e-6;
const MIN_LEG_SEP_RAD = (20 * Math.PI) / 180;
const PACK_GAP = 0.5; // unit-box widths between packed components

/** Undirected adjacency (sorted neighbour indices) over markers indexed in input order. */
function buildAdjacency(
  markers: ReadonlyArray<MarkerLike>,
  edges: ReadonlyArray<EdgeLike>,
): number[][] {
  const index = new Map<string, number>();
  markers.forEach((m, i) => index.set(m.id, i));
  const sets = markers.map(() => new Set<number>());
  for (const e of edges) {
    const a = index.get(e.from_marker_id);
    const b = index.get(e.to_marker_id);
    if (a === undefined || b === undefined || a === b) continue;
    sets[a]?.add(b);
    sets[b]?.add(a);
  }
  return sets.map((s) => [...s].sort((p, q) => p - q));
}

/** Connected components as arrays of node indices, discovered in input order. */
function connectedComponents(n: number, adj: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const seen = new Array<boolean>(n).fill(false);
  const comps: number[][] = [];
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const comp: number[] = [];
    const queue = [start];
    seen[start] = true;
    while (queue.length > 0) {
      const v = queue.shift() ?? 0;
      comp.push(v);
      for (const w of adj[v] ?? []) {
        if (!seen[w]) {
          seen[w] = true;
          queue.push(w);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/** Hop distances from one source within a component (BFS), as a length-m array. */
function bfsFrom(
  source: number,
  comp: ReadonlyArray<number>,
  adj: ReadonlyArray<ReadonlyArray<number>>,
  local: ReadonlyMap<number, number>,
): number[] {
  const dist = new Array<number>(comp.length).fill(-1);
  dist[source] = 0;
  const queue = [source];
  while (queue.length > 0) {
    const v = queue.shift() ?? 0;
    for (const gw of adj[comp[v] ?? 0] ?? []) {
      const w = local.get(gw);
      if (w === undefined || (dist[w] ?? -1) >= 0) continue;
      dist[w] = (dist[v] ?? 0) + 1;
      queue.push(w);
    }
  }
  return dist;
}

/** All-pairs hop distances within one component. `m×m`, row-major. */
function hopDistances(
  comp: ReadonlyArray<number>,
  adj: ReadonlyArray<ReadonlyArray<number>>,
): Float64Array {
  const m = comp.length;
  const local = new Map<number, number>();
  comp.forEach((g, l) => local.set(g, l));
  const d = new Float64Array(m * m);
  for (let s = 0; s < m; s++) {
    const dist = bfsFrom(s, comp, adj, local);
    for (let t = 0; t < m; t++) d[s * m + t] = dist[t] ?? 1;
  }
  return d;
}

/** A circular seed: node `t` of `m` at angle `t·2π/m`, radius `√m`. Deterministic. */
function circularSeed(m: number): Point[] {
  const r = Math.sqrt(m);
  const out: Point[] = [];
  for (let t = 0; t < m; t++) {
    const a = (t / m) * Math.PI * 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

/** One SMACOF Gauss–Seidel sweep: move each node to the stress-minimising spot
 *  given the others' current positions. Mutates `pos`. */
function smacofSweep(pos: Point[], d: Float64Array, m: number): void {
  for (let i = 0; i < m; i++) {
    const pi = pos[i];
    if (pi === undefined) continue;
    let nx = 0;
    let ny = 0;
    let den = 0;
    for (let j = 0; j < m; j++) {
      if (j === i) continue;
      const pj = pos[j];
      if (pj === undefined) continue;
      const dij = d[i * m + j] ?? 1;
      const dist = Math.max(Math.hypot(pi.x - pj.x, pi.y - pj.y), EPS);
      const w = 1 / (dij * dij);
      // target for i: pj plus the (i−j) direction scaled to the ideal distance dij.
      nx += w * (pj.x + (dij * (pi.x - pj.x)) / dist);
      ny += w * (pj.y + (dij * (pi.y - pj.y)) / dist);
      den += w;
    }
    if (den > 0) pos[i] = { x: nx / den, y: ny / den };
  }
}

interface Leg {
  readonly l: number;
  readonly ang: number;
  readonly r: number;
}

/** Smallest cyclic angular gap between consecutive legs (legs pre-sorted by angle). */
function minLegGap(legs: ReadonlyArray<Leg>): number {
  let min = Number.POSITIVE_INFINITY;
  for (let k = 0; k < legs.length; k++) {
    const cur = legs[k];
    const next = legs[(k + 1) % legs.length];
    if (cur === undefined || next === undefined) continue;
    min = Math.min(min, (next.ang - cur.ang + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2);
  }
  return min;
}

/** Fan one junction's legs to even angular spacing if any pair is too close. */
function fanOne(
  li: number,
  pos: Point[],
  comp: ReadonlyArray<number>,
  adj: ReadonlyArray<ReadonlyArray<number>>,
  local: ReadonlyMap<number, number>,
): void {
  const center = pos[li];
  if (center === undefined) return;
  const legIdx = (adj[comp[li] ?? 0] ?? [])
    .map((g) => local.get(g))
    .filter((l): l is number => l !== undefined);
  if (legIdx.length < 3) return;
  const legs: Leg[] = legIdx
    .map((l) => {
      const p = pos[l] ?? center;
      return {
        l,
        ang: Math.atan2(p.y - center.y, p.x - center.x),
        r: Math.hypot(p.x - center.x, p.y - center.y),
      };
    })
    .sort((a, b) => a.ang - b.ang);
  if (minLegGap(legs) >= MIN_LEG_SEP_RAD) return;
  const base = legs[0]?.ang ?? 0;
  const step = (Math.PI * 2) / legs.length;
  legs.forEach((leg, k) => {
    const a = base + k * step;
    pos[leg.l] = { x: center.x + Math.cos(a) * leg.r, y: center.y + Math.sin(a) * leg.r };
  });
}

/** Spread each junction's legs to ≥ 360°/degree apart when SMACOF left two within
 *  MIN_LEG_SEP — preserving their cyclic order (so no new crossing) and radius. */
function fanJunctionLegs(
  pos: Point[],
  comp: ReadonlyArray<number>,
  adj: ReadonlyArray<ReadonlyArray<number>>,
): void {
  const local = new Map<number, number>();
  comp.forEach((g, l) => local.set(g, l));
  for (let li = 0; li < comp.length; li++) fanOne(li, pos, comp, adj, local);
}

/** Scale + translate a component's points to fit [0,1]² (uniform, centred). */
function normaliseToUnitBox(pts: ReadonlyArray<Point>): Point[] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, EPS);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // centre the content in [0,1]² (a degenerate single point lands at (0.5,0.5)).
  return pts.map((p) => ({ x: 0.5 + (p.x - cx) / span, y: 0.5 + (p.y - cy) / span }));
}

/** Lay one component out: hop distances → circular seed → SMACOF → leg fan. */
function layoutComponent(
  comp: ReadonlyArray<number>,
  adj: ReadonlyArray<ReadonlyArray<number>>,
): Point[] {
  const m = comp.length;
  if (m === 1) return [{ x: 0.5, y: 0.5 }];
  const d = hopDistances(comp, adj);
  const pos = circularSeed(m);
  for (let it = 0; it < ITERATIONS; it++) smacofSweep(pos, d, m);
  fanJunctionLegs(pos, comp, adj);
  return normaliseToUnitBox(pos);
}

/**
 * Place every marker, deterministically, with graph-adjacent markers near each
 * other. Returns a Map from marker id to a point in an arbitrary (renderer-fit)
 * coordinate space — only the RELATIVE layout matters.
 */
export function layoutMarkers(
  markers: ReadonlyArray<MarkerLike>,
  edges: ReadonlyArray<EdgeLike>,
): Map<string, Point> {
  const adj = buildAdjacency(markers, edges);
  const comps = connectedComponents(markers.length, adj);
  // Pack larger components first; tie-break by smallest member id for stability.
  const minId = (comp: ReadonlyArray<number>): string =>
    comp.map((g) => markers[g]?.id ?? '').sort()[0] ?? '';
  const ordered = [...comps].sort(
    (a, b) => b.length - a.length || minId(a).localeCompare(minId(b)),
  );
  const out = new Map<string, Point>();
  let offsetX = 0;
  for (const comp of ordered) {
    const local = layoutComponent(comp, adj);
    comp.forEach((g, l) => {
      const p = local[l] ?? { x: 0.5, y: 0.5 };
      const id = markers[g]?.id;
      if (id !== undefined) out.set(id, { x: p.x + offsetX, y: p.y });
    });
    offsetX += 1 + PACK_GAP; // disjoint horizontal band per component
  }
  return out;
}
