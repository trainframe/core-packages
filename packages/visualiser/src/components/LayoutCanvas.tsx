import { type JSX, useEffect, useRef, useState } from 'react';
import { type ClearanceMap, useClearanceState } from '../state/use-clearance-state.js';
import {
  type VisualiserEdge,
  type VisualiserLayout,
  type VisualiserMarker,
  useLayoutState,
} from '../state/use-layout-state.js';
import { type TrainPositions, useTrainPositions } from '../state/use-train-positions.js';
import { type TrainStatuses, useTrainStatuses } from '../state/use-train-statuses.js';
import { trainColor, trainHue } from '../train-color.js';

interface Point {
  readonly x: number;
  readonly y: number;
}

const VIEWBOX = 600;
const CENTER = VIEWBOX / 2;
const RADIUS = CENTER - 60;
const MARKER_RADIUS = 14;

/**
 * Per-render screen-size factor. The SVG is drawn at `width=height=VIEWBOX` px
 * with a `viewBox` side of `viewport.size` world units, so the on-screen
 * px-per-world-unit is `VIEWBOX / size`. To hold a glyph at a constant *screen*
 * size of `D` px regardless of zoom, its *world* size must be `D * size /
 * VIEWBOX = D * f`. Multiplying every fixed glyph dimension (marker radius,
 * font sizes, stroke widths, train shape, arrowheads) by `f` therefore pins
 * them to a constant number of screen pixels while marker *positions* (world
 * space, unscaled) magnify on zoom-in — i.e. markers spread apart and stay
 * readable. At the fit default this renders the same ≈14px marker / 12px label
 * / 6px rail as before.
 */
function screenScale(viewportSize: number): number {
  return viewportSize / VIEWBOX;
}

/** Minimum and maximum zoom levels for wheel-zoom (1 = fit-to-content). */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

/**
 * Margin (in world units, i.e. the same units as the computed marker
 * positions) added around the graph bounding box when fitting to content, so
 * markers and their labels don't sit flush against the viewport edge.
 */
const FIT_MARGIN = MARKER_RADIUS * 3;

/**
 * Fraction of the edge length used as the bezier handle length (k factor).
 *
 * A small fraction keeps the track flowing gently. Crucially it also makes
 * near-collinear runs render *essentially straight* without any explicit
 * snapping: along such a run the Catmull-Rom marker tangent (the chord through
 * a marker's two neighbours — see `buildMarkerTangents`) already points along
 * the line, so short handles sit almost exactly on the straight line — no
 * S-wobble, no overshoot. Only genuine corners and junction legs (where the
 * tangent diverges from the chord) keep a visible curve. Using the marker
 * tangent at both ends preserves exact C1 continuity at shared markers;
 * deliberately straightening within a tolerance band would trade that
 * continuity for over-straightness, so we don't.
 */
const BEZIER_HANDLE_FRACTION = 0.15;

const ISOLATED_TANGENT: Point = { x: 1, y: 0 };

/** Unit vector from `a` to `b`, or `null` if they coincide (degenerate). */
function unitBetween(a: Point, b: Point): Point | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len <= 1e-9) return null;
  return { x: dx / len, y: dy / len };
}

/**
 * Build the UNDIRECTED neighbour set for every marker: collapse the directed
 * `A->B` / `B->A` edges into the set of DISTINCT neighbour marker ids per
 * marker, with positions resolved. Self-loops and edges to unknown/unpositioned
 * markers are skipped.
 */
function buildNeighbours(
  markers: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
  markerPositions: Map<string, Point>,
): Map<string, Set<string>> {
  const neighbours = new Map<string, Set<string>>();
  for (const m of markers) neighbours.set(m.id, new Set());

  for (const edge of edges) {
    const a = edge.from_marker_id;
    const b = edge.to_marker_id;
    if (a === b) continue;
    if (!markerPositions.has(a) || !markerPositions.has(b)) continue;
    neighbours.get(a)?.add(b);
    neighbours.get(b)?.add(a);
  }
  return neighbours;
}

/**
 * Tangent at a junction (degree ≥ 3): pick the pair of neighbours whose
 * through-line is STRAIGHTEST and use that chord as the marker's tangent.
 *
 * "Straightest" maximises |dot(unit(marker − A), unit(B − marker))| over all
 * neighbour pairs (A, B): the most-collinear pair is the layout's main line
 * running through the junction. Using that chord makes the main line flow
 * smoothly across the junction; the branch edge(s) join at the junction and
 * may visibly kink there (its far end stays smooth via that marker's own
 * tangent). The dot metric is symmetric in (A, B) so unordered pairs suffice;
 * first-max-wins makes ties deterministic.
 *
 * Returns the chord `unit(B.pos − A.pos)`, or `null` if every pair is
 * degenerate (caller falls back).
 */
/**
 * Collinearity score in [0, 1] of the through-line A → self → B:
 * |dot(unit(self − A), unit(B − self))|. 1 = perfectly straight, 0 =
 * right-angle. `null` if either leg is degenerate.
 */
function throughLineScore(self: Point, a: Point, b: Point): number | null {
  const inDir = unitBetween(a, self);
  const outDir = unitBetween(self, b);
  if (inDir === null || outDir === null) return null;
  return Math.abs(inDir.x * outDir.x + inDir.y * outDir.y);
}

function junctionTangent(self: Point, neighbourPositions: ReadonlyArray<Point>): Point | null {
  let best: Point | null = null;
  let bestScore = -1;
  for (let i = 0; i < neighbourPositions.length; i++) {
    const a = neighbourPositions[i];
    for (let j = i + 1; a !== undefined && j < neighbourPositions.length; j++) {
      const b = neighbourPositions[j];
      const score = b === undefined ? null : throughLineScore(self, a, b);
      const chord = b === undefined ? null : unitBetween(a, b);
      if (score !== null && chord !== null && score > bestScore) {
        bestScore = score;
        best = chord;
      }
    }
  }
  return best;
}

/**
 * Build a map from marker ID to unit tangent vector for that marker, derived
 * from the UNDIRECTED graph using neighbour POSITIONS (Catmull-Rom style).
 *
 * Edges are bidirectional, so a directed-edge-direction sum would cancel to
 * zero at every interior marker — instead we collapse to undirected neighbours
 * and read the geometry off their positions:
 *
 *   - degree 2 (neighbours P, Q): tangent = unit(Q.pos − P.pos), the chord
 *     through the marker. Consecutive edges then share this tangent at their
 *     shared marker → the whole run flows as one smooth C1 curve.
 *   - degree 1 (terminus): tangent = unit(marker.pos − P.pos).
 *   - degree ≥ 3 (junction): the straightest neighbour pair's chord — see
 *     `junctionTangent`; the main line flows through, branches join.
 *   - degree 0 (isolated) or any degenerate fallback: {1, 0}.
 *
 * The tangent's SIGN is unconstrained: `edgeBezierControls` re-orients it per
 * edge toward the chord, so the rendered curve is sign-invariant.
 */
/**
 * The unit tangent at one marker given its (position-resolved) distinct
 * neighbours, by degree. See `buildMarkerTangents` for the rules. Returns
 * `null` when every relevant chord is degenerate (caller falls back).
 */
function markerTangent(self: Point, neighbourPositions: ReadonlyArray<Point>): Point | null {
  if (neighbourPositions.length === 1) {
    const [p] = neighbourPositions;
    return p === undefined ? null : unitBetween(p, self);
  }
  if (neighbourPositions.length === 2) {
    const [p, q] = neighbourPositions;
    return p === undefined || q === undefined ? null : unitBetween(p, q);
  }
  return junctionTangent(self, neighbourPositions);
}

export function buildMarkerTangents(
  markers: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
  markerPositions: Map<string, Point>,
): Map<string, Point> {
  const neighbours = buildNeighbours(markers, edges, markerPositions);
  const tangents = new Map<string, Point>();

  for (const m of markers) {
    const self = markerPositions.get(m.id);
    const adj = neighbours.get(m.id);
    if (self === undefined || adj === undefined || adj.size === 0) {
      tangents.set(m.id, ISOLATED_TANGENT);
      continue;
    }

    const positions: Point[] = [];
    for (const id of adj) {
      const p = markerPositions.get(id);
      if (p !== undefined) positions.push(p);
    }

    tangents.set(m.id, markerTangent(self, positions) ?? ISOLATED_TANGENT);
  }

  return tangents;
}

/**
 * Compute the two cubic bezier control points for an edge using
 * marker tangents for C1 continuity at shared markers.
 *
 * C1: from + tangent[from] * k  (departs `from` along its tangent)
 * C2: to   - tangent[to]   * k  (arrives at `to` along its tangent)
 *
 * k = BEZIER_HANDLE_FRACTION * distance(from, to)
 *
 * Sign of tangent[to] is negated because the control point must lie
 * *before* `to` on the curve (i.e. on the side that the edge comes from).
 * Since the tangent convention is "forward" (the direction the track flows
 * through the marker), arriving at `to` from the `from` direction means the
 * handle is placed at `to - tangent[to] * k`.
 */
function edgeBezierControls(
  from: Point,
  to: Point,
  tangentFrom: Point,
  tangentTo: Point,
): { c1: Point; c2: Point } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { c1: from, c2: to };

  const k = len * BEZIER_HANDLE_FRACTION;

  // Orient each marker tangent toward `to` along the chord. The tangent is a
  // unit "forward through marker" vector; if it points mostly away from the
  // chord direction, flip it so the handle lands on the correct side. Using
  // the marker tangent (not the chord) at both ends is what gives C1
  // continuity at shared markers.
  function handleDir(tangent: Point): Point {
    const dot = tangent.x * dx + tangent.y * dy;
    const sign = dot >= 0 ? 1 : -1;
    return { x: sign * tangent.x, y: sign * tangent.y };
  }

  const hFrom = handleDir(tangentFrom);
  const hTo = handleDir(tangentTo);

  return {
    c1: { x: from.x + hFrom.x * k, y: from.y + hFrom.y * k },
    c2: { x: to.x - hTo.x * k, y: to.y - hTo.y * k },
  };
}

/**
 * Sample a cubic bezier at parameter t ∈ [0,1].
 * B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
 */
function cubicBezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: u3 * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t3 * p3.x,
    y: u3 * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t3 * p3.y,
  };
}

/**
 * Sample the derivative of the cubic bezier at parameter t.
 * B'(t) = 3[(1-t)²(P1-P0) + 2(1-t)t(P2-P1) + t²(P3-P2)]
 */
function cubicBezierTangent(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const ax = p1.x - p0.x;
  const ay = p1.y - p0.y;
  const bx = p2.x - p1.x;
  const by = p2.y - p1.y;
  const cx = p3.x - p2.x;
  const cy = p3.y - p2.y;
  return {
    x: 3 * (u * u * ax + 2 * u * t * bx + t * t * cx),
    y: 3 * (u * u * ay + 2 * u * t * by + t * t * cy),
  };
}

/**
 * Build the SVG `d` attribute for a cubic bezier from `from` to `to`.
 */
function bezierPathD(from: Point, to: Point, c1: Point, c2: Point): string {
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

/**
 * Build an SVG `<path>` `d` for the train body shape.
 *
 * Shape (local coordinates, x-axis is forward, tip points right):
 *
 *   back-left (-halfL, -halfW)
 *   back-right (-halfL, +halfW)
 *   front-right (noseX, +halfW)   — where the rectangular body ends
 *   nose tip (halfL, 0)           — a pointier front, curved sides
 *   front-left (noseX, -halfW)
 *
 *   noseX = halfL - halfW * 3     (the nose depth is 3× half-width, giving a
 *                                   long, pointy front rather than a soft
 *                                   bullet nose)
 *
 * The back edge and both sides are straight lines (rectangular body).
 * The front is two quadratic curves that meet at the tip; with the control
 * point pulled most of the way toward the tip, the sides only ease slightly
 * away from the body line before tapering to a sharp point.  Back corners
 * are sharp to give a clear "rear of train" read.
 */
function trainShapeD(halfL: number, halfW: number): string {
  const rearX = -halfL;
  // Rectangular body runs from rearX to noseX. The rectangle's dimensions
  // are fixed by the caller's halfL/halfW — only the nose protrusion and
  // corner softness are tuned here.
  const noseX = halfL - halfW * 1.5;
  const tipX = halfL;
  // Each corner is rounded with a quadratic Bezier: the straight edges
  // stop short by `r`, and a Q curve with the control point at the
  // corner's geometric apex bridges them. Bigger r = softer corners.
  // `halfW * 0.3` reads as a clear chamfer without losing the
  // rectangle-plus-triangle silhouette.
  const r = halfW * 0.3;
  // The triangular sides are straight for most of the nose. The last
  // ~30% rounds off into the apex.
  const roundStartX = noseX + (tipX - noseX) * 0.7;
  const roundStartY = halfW * 0.3;

  return [
    // Start just after the back-left corner, on the top edge.
    `M ${rearX + r} ${-halfW}`,
    // Top edge across to just before the body→nose corner on the left.
    `L ${noseX - r} ${-halfW}`,
    // Round the left body→nose corner.
    `Q ${noseX} ${-halfW}, ${noseX + r * 0.5} ${-halfW + r * 0.5}`,
    // Up the left side of the nose taper to just before the apex.
    `L ${roundStartX} ${-roundStartY}`,
    // Rounded apex.
    `Q ${tipX} 0, ${roundStartX} ${roundStartY}`,
    // Down the right side of the nose taper to just after the
    // right body→nose corner.
    `L ${noseX + r * 0.5} ${halfW - r * 0.5}`,
    // Round the right body→nose corner.
    `Q ${noseX} ${halfW}, ${noseX - r} ${halfW}`,
    // Bottom edge back to just before the back-right corner.
    `L ${rearX + r} ${halfW}`,
    // Round the back-right corner.
    `Q ${rearX} ${halfW}, ${rearX} ${halfW - r}`,
    // Back edge up to just before the back-left corner.
    `L ${rearX} ${-halfW + r}`,
    // Round the back-left corner, closing the path.
    `Q ${rearX} ${-halfW}, ${rearX + r} ${-halfW}`,
    'Z',
  ].join(' ');
}

/**
 * A connection between two markers, collapsing the (up to two) DIRECTED edges
 * the data carries for that pair into a single undirected rail to render.
 *
 * `forward` is the direction we draw the curve in (and the direction a one-way
 * arrowhead points). For a two-way pair it's arbitrary (the smaller marker id
 * first, for stable ordering); for a one-way pair it's the permitted direction.
 */
interface MergedEdge {
  /** Stable key for the unordered pair: `${min}|${max}`. */
  readonly pairKey: string;
  readonly forward: VisualiserEdge;
  readonly oneWay: boolean;
  /** True if either directed edge is `inferred`. */
  readonly inferred: boolean;
}

/** Unordered-pair key: the two marker ids sorted, joined by `|`. */
function pairKeyOf(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Collapse the directed `layout.edges` into one `MergedEdge` per undirected
 * marker pair. A pair present in both directions is two-way (drawn as the
 * default rail); a pair present in only one direction is one-way (drawn with
 * an arrowhead in the permitted direction).
 *
 * The edge MODEL is untouched — this is purely a rendering merge. Insertion
 * order of first-seen pairs is preserved so the rendered output is stable.
 */
export function mergeEdges(edges: ReadonlyArray<VisualiserEdge>): MergedEdge[] {
  const byPair = new Map<string, { forward: VisualiserEdge; reverse?: VisualiserEdge }>();
  const order: string[] = [];
  for (const edge of edges) {
    const key = pairKeyOf(edge.from_marker_id, edge.to_marker_id);
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, { forward: edge });
      order.push(key);
    } else if (
      existing.forward.from_marker_id === edge.to_marker_id &&
      existing.forward.to_marker_id === edge.from_marker_id
    ) {
      // The opposite direction of an already-seen edge → two-way.
      existing.reverse = edge;
    }
    // A duplicate of the same direction is ignored (model shouldn't emit it).
  }

  const out: MergedEdge[] = [];
  for (const key of order) {
    const entry = byPair.get(key);
    if (entry === undefined) continue;
    const oneWay = entry.reverse === undefined;
    out.push({
      pairKey: key,
      forward: entry.forward,
      oneWay,
      inferred: (entry.forward.inferred ?? false) || (entry.reverse?.inferred ?? false),
    });
  }
  return out;
}

/**
 * The train holding this pair (if any) and the direction it holds, by checking
 * both directed keys in the clearance map. Prefers the forward direction when
 * both are somehow present.
 */
function clearanceForPair(
  forward: VisualiserEdge,
  clearanceMap: ClearanceMap,
): {
  holder: string;
  from: VisualiserEdge['from_marker_id'];
  to: VisualiserEdge['to_marker_id'];
} | null {
  const fwdKey = `${forward.from_marker_id}->${forward.to_marker_id}`;
  const revKey = `${forward.to_marker_id}->${forward.from_marker_id}`;
  const fwdHolder = clearanceMap.get(fwdKey);
  if (fwdHolder !== undefined) {
    return { holder: fwdHolder, from: forward.from_marker_id, to: forward.to_marker_id };
  }
  const revHolder = clearanceMap.get(revKey);
  if (revHolder !== undefined) {
    return { holder: revHolder, from: forward.to_marker_id, to: forward.from_marker_id };
  }
  return null;
}

/**
 * Build the arrowhead glyph for a one-way (or cleared-directional) edge: a
 * small triangle at the curve midpoint pointing along the direction of travel.
 * Sampled from the same bezier the rail is drawn on so it sits on the track,
 * and filled with the rail's stroke colour (so a cleared one-way edge gets the
 * train's hue for free — a shared `<marker>` def couldn't match the hashed
 * train colour).
 */
function arrowheadPolygon(
  from: Point,
  to: Point,
  c1: Point,
  c2: Point,
  fill: string,
  f: number,
): JSX.Element {
  const mid = cubicBezierPoint(from, c1, c2, to, 0.5);
  const tan = cubicBezierTangent(from, c1, c2, to, 0.5);
  const angleDeg = Math.atan2(tan.y, tan.x) * (180 / Math.PI);
  // Local triangle: tip forward (+x), base behind. Sized relative to the rail.
  // The midpoint position is world-space (unscaled); the glyph's *size* is held
  // at a constant screen size via the trailing `scale(f)` — see `screenScale`.
  const len = MARKER_RADIUS * 0.9;
  const half = MARKER_RADIUS * 0.55;
  const points = `${len},0 ${-len * 0.4},${half} ${-len * 0.4},${-half}`;
  return (
    <polygon
      points={points}
      fill={fill}
      transform={`translate(${mid.x},${mid.y}) rotate(${angleDeg}) scale(${f})`}
      data-edge-arrow="true"
    />
  );
}

const EDGE_COLOR = 'var(--tf-vis-color-edge, #888)';
const EDGE_INFERRED_COLOR = 'var(--tf-vis-color-edge-inferred, #aaa)';

/**
 * Rail stroke colour. SVG presentation attributes ignore CSS `var()` in real
 * browsers, so theme-token colours go through inline `style`. A cleared edge
 * takes the holding train's hue; an inferred (un-cleared) edge a muted grey.
 */
function railStroke(clearedTo: string, inferred: boolean): string {
  if (clearedTo !== '') return trainColor(clearedTo);
  return inferred ? EDGE_INFERRED_COLOR : EDGE_COLOR;
}

/** Render a single merged edge as a `<path>` rail plus optional arrowhead glyph. */
function renderMergedEdge(
  merged: MergedEdge,
  markerPositions: Map<string, Point>,
  markerTangents: Map<string, Point>,
  clearanceMap: ClearanceMap,
  f: number,
): JSX.Element | null {
  const cleared = clearanceForPair(merged.forward, clearanceMap);
  // Draw in the cleared direction when a train holds it (so the train's
  // arrowhead reads correctly), otherwise in the merged edge's forward sense.
  const fromId = cleared?.from ?? merged.forward.from_marker_id;
  const toId = cleared?.to ?? merged.forward.to_marker_id;
  const from = markerPositions.get(fromId);
  const to = markerPositions.get(toId);
  if (!from || !to) return null;

  const tFrom = markerTangents.get(fromId) ?? { x: 1, y: 0 };
  const tTo = markerTangents.get(toId) ?? { x: 1, y: 0 };
  const { c1, c2 } = edgeBezierControls(from, to, tFrom, tTo);
  const d = bezierPathD(from, to, c1, c2);

  const clearedTo = cleared?.holder ?? '';
  const stroke = railStroke(clearedTo, merged.inferred);
  const inferredProps =
    merged.inferred && clearedTo === '' ? { strokeDasharray: '8 6', 'data-inferred': 'true' } : {};

  // An arrowhead is shown when the edge is one-way (always) or when a train
  // holds it (to show which way clearance points). Two-way uncleared edges
  // render as a plain bidirectional rail with no arrowhead.
  const showArrow = merged.oneWay || clearedTo !== '';
  const arrow = showArrow
    ? arrowheadPolygon(from, to, c1, c2, clearedTo !== '' ? stroke : EDGE_COLOR, f)
    : null;

  return (
    <g
      key={merged.pairKey}
      data-edge-pair={merged.pairKey}
      data-direction={merged.oneWay ? 'one-way' : 'two-way'}
    >
      <path
        d={d}
        fill="none"
        style={{ stroke }}
        strokeWidth={(clearedTo !== '' ? 9 : 6) * f}
        strokeLinecap="round"
        data-cleared-to={clearedTo}
        {...inferredProps}
      />
      {arrow}
    </g>
  );
}

/** A square world-space window: top-left corner + side length (world units). */
interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/**
 * Apply a wheel-zoom to `prev`, keeping the world point under the cursor fixed.
 * `deltaY < 0` (scroll up) zooms in; the new window size is clamped so zoom
 * stays within [MIN_ZOOM, MAX_ZOOM] relative to the *fit* size embedded in the
 * gesture. Falls back to centre-anchored when the rect has zero dimensions
 * (jsdom). Pure.
 */
function zoomViewport(
  prev: Viewport,
  rect: DOMRect,
  clientX: number,
  clientY: number,
  deltaY: number,
): Viewport {
  const zoomFactor = deltaY < 0 ? 1 / 1.15 : 1.15;
  // size shrinks as we zoom IN. Clamp against the gesture's own size so the
  // window can't collapse below MIN_ZOOM or expand past MAX_ZOOM of itself.
  const newSize = Math.min(
    prev.size / MIN_ZOOM,
    Math.max(prev.size / MAX_ZOOM, prev.size * zoomFactor),
  );
  const fracX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const fracY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  // World point under the cursor before the zoom.
  const worldX = prev.x + fracX * prev.size;
  const worldY = prev.y + fracY * prev.size;
  return {
    x: worldX - fracX * newSize,
    y: worldY - fracY * newSize,
    size: newSize,
  };
}

/**
 * Translate `start` by a client-space drag delta, converting px to world units
 * via the rect. Dragging right/down moves the content right/down (origin moves
 * opposite the drag). Falls back to no movement on a zero-size rect. Pure.
 */
function panViewport(start: Viewport, rect: DOMRect, dxPx: number, dyPx: number): Viewport {
  const dxWorld = rect.width > 0 ? -(dxPx / rect.width) * start.size : 0;
  const dyWorld = rect.height > 0 ? -(dyPx / rect.height) * start.size : 0;
  return { x: start.x + dxWorld, y: start.y + dyWorld, size: start.size };
}

/**
 * Compute the square fit-to-content viewport for a set of marker positions:
 * the graph bounding box, expanded to a square (so the SVG's 1:1 aspect ratio
 * doesn't distort the layout) and padded by `FIT_MARGIN`. Falls back to the
 * legacy 0..VIEWBOX window when there are no positioned markers.
 */
function fitViewport(markerPositions: Map<string, Point>): Viewport {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of markerPositions.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, size: VIEWBOX };
  const w = maxX - minX;
  const h = maxY - minY;
  const size = Math.max(w, h, 1) + FIT_MARGIN * 2;
  // Centre the (possibly non-square) bbox inside the square window.
  return {
    x: minX - (size - w) / 2,
    y: minY - (size - h) / 2,
    size,
  };
}

/**
 * SVG visualisation of the active layout. Markers are placed in a circle
 * (auto-layout) when their spatial position isn't supplied; otherwise, the
 * marker's `position.x_mm` / `position.y_mm` is used directly. Edges are
 * cubic bezier paths; trains render as top-down pointed shapes at their
 * interpolated position along the edge, rotated to face their direction of travel.
 *
 * Bidirectional marker pairs render as a SINGLE rail (see `mergeEdges`); the
 * SVG is pannable (drag) and zoomable (wheel) and fits the graph to the
 * viewport by default.
 */
export function LayoutCanvas() {
  const layout = useLayoutState();
  const trains = useTrainPositions();
  const trainStatuses = useTrainStatuses();
  const clearanceMap = useClearanceState();

  if (!layout) {
    return (
      <section aria-label="Layout">
        <h2>Layout</h2>
        <p data-testid="layout-empty">Waiting for layout state…</p>
      </section>
    );
  }

  return (
    <LayoutSvg
      layout={layout}
      trains={trains}
      trainStatuses={trainStatuses}
      clearanceMap={clearanceMap}
    />
  );
}

interface LayoutSvgProps {
  readonly layout: VisualiserLayout;
  readonly trains: TrainPositions;
  readonly trainStatuses: TrainStatuses;
  readonly clearanceMap: ClearanceMap;
}

/**
 * The drawn SVG for a known-present layout. Split out from `LayoutCanvas` so
 * the pan/zoom hooks run unconditionally (they sit below the `!layout` early
 * return, which would otherwise violate the rules-of-hooks).
 */
function LayoutSvg({ layout, trains, trainStatuses, clearanceMap }: LayoutSvgProps) {
  const markerPositions = computeMarkerPositions(layout);
  const edgeIndex = indexEdges(layout.edges);
  const markerTangents = buildMarkerTangents(layout.markers, layout.edges, markerPositions);
  const mergedEdges = mergeEdges(layout.edges);

  const svgRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState<Viewport>(() => fitViewport(markerPositions));

  // Re-fit when the layout (its name / topology) changes. Keyed on a cheap
  // signature so re-renders from train/clearance updates don't reset the view.
  const fitSignature = `${layout.name}:${layout.markers.length}:${layout.edges.length}`;
  const lastFitRef = useRef(fitSignature);
  if (lastFitRef.current !== fitSignature) {
    lastFitRef.current = fitSignature;
    // Defer the state write to an effect-free path: compute the new fit now and
    // set it. Calling setViewport during render is the React-sanctioned way to
    // adjust state on a prop change (it re-renders before committing).
    setViewport(fitViewport(markerPositions));
  }

  // Non-passive wheel listener so we can preventDefault page scroll while
  // zooming on the canvas (mirrors ToyTable). Cursor-anchored zoom.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = svg?.getBoundingClientRect() ?? new DOMRect();
      setViewport((prev) => zoomViewport(prev, rect, e.clientX, e.clientY, e.deltaY));
    }
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const panStartRef = useRef<{ clientX: number; clientY: number; viewport: Viewport } | null>(null);

  function getRect(): DOMRect {
    return svgRef.current?.getBoundingClientRect() ?? new DOMRect();
  }

  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    panStartRef.current = { clientX: e.clientX, clientY: e.clientY, viewport };
    const svg = e.currentTarget;
    if (typeof svg.setPointerCapture === 'function') svg.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const start = panStartRef.current;
    if (start === null) return;
    const rect = getRect();
    setViewport(
      panViewport(start.viewport, rect, e.clientX - start.clientX, e.clientY - start.clientY),
    );
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    panStartRef.current = null;
    const svg = e.currentTarget;
    if (typeof svg.releasePointerCapture === 'function') {
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        // jsdom may throw if the pointer was never captured.
      }
    }
  }

  const viewBox = `${viewport.x} ${viewport.y} ${viewport.size} ${viewport.size}`;
  // Per-render factor that holds every glyph at a constant screen size as the
  // viewBox window (and thus zoom) changes. See `screenScale`.
  const f = screenScale(viewport.size);

  return (
    <section aria-label="Layout">
      <h2>Layout · {layout.name}</h2>
      <svg
        ref={svgRef}
        viewBox={viewBox}
        width={VIEWBOX}
        height={VIEWBOX}
        role="img"
        aria-label={`Track diagram for ${layout.name}`}
        data-testid="layout-canvas"
        data-viewport-x={viewport.x}
        data-viewport-y={viewport.y}
        data-viewport-size={viewport.size}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ touchAction: 'none', cursor: 'grab' }}
      >
        <title>Track diagram for {layout.name}</title>
        <g data-testid="edges">
          {mergedEdges.map((merged) =>
            renderMergedEdge(merged, markerPositions, markerTangents, clearanceMap, f),
          )}
        </g>
        <g data-testid="markers">
          {layout.markers.map((marker) => {
            const p = markerPositions.get(marker.id);
            if (!p) return null;
            return (
              <g key={marker.id} data-marker-id={marker.id}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={MARKER_RADIUS * f}
                  style={{
                    fill: 'var(--tf-vis-color-marker, #fff)',
                    stroke: 'var(--tf-vis-color-marker-stroke, #333)',
                  }}
                  strokeWidth={2 * f}
                />
                <text
                  x={p.x}
                  y={p.y + 4 * f}
                  textAnchor="middle"
                  fontSize={12 * f}
                  fontFamily="sans-serif"
                >
                  {marker.label ?? marker.id}
                </text>
              </g>
            );
          })}
        </g>
        <g data-testid="trains">
          {renderTrains(trains, trainStatuses, markerPositions, edgeIndex, markerTangents, f)}
        </g>
      </svg>
    </section>
  );
}

/**
 * Half-length and half-width of the train shape in SVG units.
 * The total body length is 2 * TRAIN_HALF_L plus the nose protrusion.
 * Proportions: roughly 2.5× as long as wide when the nose is included.
 */
const TRAIN_HALF_L = MARKER_RADIUS * 1.3;
const TRAIN_HALF_W = MARKER_RADIUS * 0.6;

const TRAIN_SHAPE_D = trainShapeD(TRAIN_HALF_L, TRAIN_HALF_W);

function renderTrains(
  trains: TrainPositions,
  statuses: TrainStatuses,
  markerPositions: Map<string, Point>,
  edgeIndex: Map<string, VisualiserEdge>,
  markerTangents: Map<string, Point>,
  f: number,
): JSX.Element[] {
  const out: JSX.Element[] = [];
  const trainIds = new Set<string>([...trains.keys(), ...statuses.keys()]);

  for (const trainId of trainIds) {
    const placement = placeTrain(
      trainId,
      trains,
      statuses,
      markerPositions,
      edgeIndex,
      markerTangents,
    );
    if (!placement) continue;
    const { x, y, angleDeg, atMarker, onEdge } = placement;

    const fill = trainColor(trainId);
    // Darker stroke: same hue but much lower lightness.
    const hue = trainHue(trainId);
    const stroke = `hsl(${hue}, 70%, 25%)`;

    out.push(
      <g
        key={trainId}
        data-train-id={trainId}
        {...(atMarker ? { 'data-at-marker': atMarker } : {})}
        {...(onEdge ? { 'data-on-edge': onEdge } : {})}
      >
        <path
          d={TRAIN_SHAPE_D}
          fill={fill}
          stroke={stroke}
          strokeWidth={1.5}
          transform={`translate(${x},${y}) rotate(${angleDeg}) scale(${f})`}
        />
        <text
          x={x}
          y={y - (TRAIN_HALF_L + MARKER_RADIUS * 0.5) * f}
          textAnchor="middle"
          fontSize={11 * f}
          fontFamily="sans-serif"
          fill={stroke}
        >
          {trainId}
        </text>
      </g>,
    );
  }
  return out;
}

interface TrainPlacement extends Point {
  readonly angleDeg: number;
  readonly atMarker?: string;
  readonly onEdge?: string;
}

/**
 * Prefer the latest `train_status` for mid-edge interpolation. Fall back to
 * the last `marker_traversed` snap-to-marker when status hasn't arrived yet.
 * The returned position is sampled from the edge's bezier curve so the train
 * icon sits on the rendered track, and `angleDeg` is the bezier tangent angle
 * at that point (used to rotate the icon to face its direction of travel).
 */
function placeTrain(
  trainId: string,
  trains: TrainPositions,
  statuses: TrainStatuses,
  markerPositions: Map<string, Point>,
  edgeIndex: Map<string, VisualiserEdge>,
  markerTangents: Map<string, Point>,
): TrainPlacement | undefined {
  const status = statuses.get(trainId);
  if (status?.current_edge) {
    const from = markerPositions.get(status.current_edge.from_marker_id);
    const to = markerPositions.get(status.current_edge.to_marker_id);
    if (from && to) {
      const key = edgeKey(status.current_edge);
      const edge = edgeIndex.get(key);
      const length = edge?.estimated_length_mm;
      const distance = status.distance_into_edge_mm ?? 0;
      const t = length && length > 0 ? Math.min(1, Math.max(0, distance / length)) : 0;
      const tFrom = markerTangents.get(status.current_edge.from_marker_id) ?? { x: 1, y: 0 };
      const tTo = markerTangents.get(status.current_edge.to_marker_id) ?? { x: 1, y: 0 };
      const { c1, c2 } = edgeBezierControls(from, to, tFrom, tTo);
      const pt = cubicBezierPoint(from, c1, c2, to, t);
      const tangent = cubicBezierTangent(from, c1, c2, to, t);
      const angleDeg = Math.atan2(tangent.y, tangent.x) * (180 / Math.PI);
      return { x: pt.x, y: pt.y, angleDeg, onEdge: key };
    }
  }

  const markerId = trains.get(trainId);
  if (markerId) {
    const p = markerPositions.get(markerId);
    if (p) return { x: p.x, y: p.y, angleDeg: 0, atMarker: markerId };
  }
  return undefined;
}

function edgeKey(e: { from_marker_id: string; to_marker_id: string }): string {
  return `${e.from_marker_id}->${e.to_marker_id}`;
}

function indexEdges(edges: ReadonlyArray<VisualiserEdge>): Map<string, VisualiserEdge> {
  const out = new Map<string, VisualiserEdge>();
  for (const edge of edges) out.set(edgeKey(edge), edge);
  return out;
}

function computeMarkerPositions(layout: VisualiserLayout): Map<string, Point> {
  const out = new Map<string, Point>();
  const spatial = layout.markers.filter((m) => m.position !== undefined);
  if (spatial.length === layout.markers.length && spatial.length > 0) {
    return scaleSpatialPositions(layout.markers);
  }
  // Auto-place: evenly spaced around a circle, in marker-array order.
  const n = layout.markers.length;
  layout.markers.forEach((marker, i) => {
    const angle = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
    out.set(marker.id, {
      x: CENTER + Math.cos(angle) * RADIUS,
      y: CENTER + Math.sin(angle) * RADIUS,
    });
  });
  return out;
}

function scaleSpatialPositions(markers: ReadonlyArray<VisualiserMarker>): Map<string, Point> {
  const out = new Map<string, Point>();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const m of markers) {
    if (!m.position) continue;
    minX = Math.min(minX, m.position.x_mm);
    minY = Math.min(minY, m.position.y_mm);
    maxX = Math.max(maxX, m.position.x_mm);
    maxY = Math.max(maxY, m.position.y_mm);
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const span = Math.max(spanX, spanY);
  const scale = (RADIUS * 1.6) / span;
  const offsetX = CENTER - ((minX + maxX) / 2) * scale;
  const offsetY = CENTER - ((minY + maxY) / 2) * scale;
  for (const m of markers) {
    if (!m.position) continue;
    out.set(m.id, {
      x: m.position.x_mm * scale + offsetX,
      y: m.position.y_mm * scale + offsetY,
    });
  }
  return out;
}
