import type { JSX } from 'react';
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
 * Fraction of the edge length used as the bezier handle length (k factor).
 * Controls how tightly curved the arcs are. 0.3 gives smooth, readable arcs.
 */
const BEZIER_HANDLE_FRACTION = 0.3;

/** Accumulate unit-vector edge contributions into a per-marker sum map. */
function accumulateEdgeContributions(
  edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
  markerPositions: Map<string, Point>,
  sums: Map<string, { x: number; y: number }>,
): void {
  for (const edge of edges) {
    const fromPos = markerPositions.get(edge.from_marker_id);
    const toPos = markerPositions.get(edge.to_marker_id);
    if (!fromPos || !toPos) continue;

    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) continue;

    const ux = dx / len;
    const uy = dy / len;

    // Both endpoints get the same unit vector: the tangent convention is
    // "the direction this edge flows" (from → to). For the `from` marker it
    // is an outgoing contribution; for `to` it is the incoming direction
    // (arriving from the same direction), which is the same vector. Summing
    // and re-normalising produces a tangent that "points through" each marker.
    const fromSum = sums.get(edge.from_marker_id);
    if (fromSum) {
      fromSum.x += ux;
      fromSum.y += uy;
    }
    const toSum = sums.get(edge.to_marker_id);
    if (toSum) {
      toSum.x += ux;
      toSum.y += uy;
    }
  }
}

/**
 * Return a degenerate-fallback tangent for a marker whose directional sum
 * cancelled out to zero: perpendicular to the first incident edge found,
 * or (1, 0) if no edge can be located.
 */
function degenerateTangent(
  markerId: string,
  edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
  markerPositions: Map<string, Point>,
): Point {
  for (const edge of edges) {
    if (edge.from_marker_id !== markerId && edge.to_marker_id !== markerId) continue;
    const fromPos = markerPositions.get(edge.from_marker_id);
    const toPos = markerPositions.get(edge.to_marker_id);
    if (!fromPos || !toPos) continue;
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const elen = Math.sqrt(dx * dx + dy * dy);
    if (elen > 1e-9) return { x: -dy / elen, y: dx / elen };
  }
  return { x: 1, y: 0 };
}

/**
 * Build a map from marker ID to unit tangent vector for that marker.
 *
 * The tangent at a marker is the normalised sum of all incident edge
 * direction contributions (outgoing and incoming both contribute the edge's
 * unit direction vector). This makes consecutive edges share their tangent at
 * the meeting marker, giving C1-continuous bezier arcs.
 *
 * If the sum is zero (symmetric opposing edges exactly cancel), falls back to
 * the right-hand perpendicular of the first incident edge, or (1, 0) if none.
 */
export function buildMarkerTangents(
  markers: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
  markerPositions: Map<string, Point>,
): Map<string, Point> {
  const tangents = new Map<string, Point>();
  const sums = new Map<string, { x: number; y: number }>();
  for (const m of markers) sums.set(m.id, { x: 0, y: 0 });

  accumulateEdgeContributions(edges, markerPositions, sums);

  for (const m of markers) {
    const sum = sums.get(m.id);
    if (!sum) continue;
    const len = Math.sqrt(sum.x * sum.x + sum.y * sum.y);
    tangents.set(
      m.id,
      len > 1e-9
        ? { x: sum.x / len, y: sum.y / len }
        : degenerateTangent(m.id, edges, markerPositions),
    );
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

  // Ensure the handle at `from` points toward `to` (not away from it).
  // The tangent is a unit "forward through marker" vector; if it points
  // mostly away from `to`, flip it so the curve exits toward `to`.
  const dotFrom = tangentFrom.x * dx + tangentFrom.y * dy;
  const signFrom = dotFrom >= 0 ? 1 : -1;

  // Similarly for the `to` handle: tangent[to] should point *away* from
  // the edge (the curve arrives at `to`, so the handle sits behind `to`).
  // The arriving direction is from→to, so the handle direction must align
  // with that: we subtract tangent[to]*k from `to`. If tangent[to] points
  // away from `from` (dot > 0), we negate so the handle lands on the correct side.
  const dotTo = tangentTo.x * dx + tangentTo.y * dy;
  const signTo = dotTo >= 0 ? 1 : -1;

  return {
    c1: { x: from.x + signFrom * tangentFrom.x * k, y: from.y + signFrom * tangentFrom.y * k },
    c2: { x: to.x - signTo * tangentTo.x * k, y: to.y - signTo * tangentTo.y * k },
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

/** Render a single edge as a `<path>`, or null if endpoint positions are missing. */
function renderEdge(
  edge: VisualiserEdge,
  markerPositions: Map<string, Point>,
  markerTangents: Map<string, Point>,
  clearanceMap: ClearanceMap,
): JSX.Element | null {
  const from = markerPositions.get(edge.from_marker_id);
  const to = markerPositions.get(edge.to_marker_id);
  if (!from || !to) return null;

  const key = `${edge.from_marker_id}->${edge.to_marker_id}`;
  const clearedTo = clearanceMap.get(key) ?? '';
  const tFrom = markerTangents.get(edge.from_marker_id) ?? { x: 1, y: 0 };
  const tTo = markerTangents.get(edge.to_marker_id) ?? { x: 1, y: 0 };
  const { c1, c2 } = edgeBezierControls(from, to, tFrom, tTo);
  const d = bezierPathD(from, to, c1, c2);
  const stroke = clearedTo ? trainColor(clearedTo) : edge.inferred ? '#aaa' : '#888';
  const inferredProps =
    edge.inferred && !clearedTo ? { strokeDasharray: '8 6', 'data-inferred': 'true' } : {};

  return (
    <path
      key={key}
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={clearedTo ? 9 : 6}
      strokeLinecap="round"
      data-cleared-to={clearedTo}
      {...inferredProps}
    />
  );
}

/**
 * SVG visualisation of the active layout. Markers are placed in a circle
 * (auto-layout) when their spatial position isn't supplied; otherwise, the
 * marker's `position.x_mm` / `position.y_mm` is used directly. Edges are
 * cubic bezier paths; trains render as top-down pointed shapes at their
 * interpolated position along the edge, rotated to face their direction of travel.
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

  const markerPositions = computeMarkerPositions(layout);
  const edgeIndex = indexEdges(layout.edges);
  const markerTangents = buildMarkerTangents(layout.markers, layout.edges, markerPositions);

  return (
    <section aria-label="Layout">
      <h2>Layout · {layout.name}</h2>
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        width={VIEWBOX}
        height={VIEWBOX}
        role="img"
        aria-label={`Track diagram for ${layout.name}`}
      >
        <title>Track diagram for {layout.name}</title>
        <g data-testid="edges">
          {layout.edges.map((edge) =>
            renderEdge(edge, markerPositions, markerTangents, clearanceMap),
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
                  r={MARKER_RADIUS}
                  fill="#fff"
                  stroke="#333"
                  strokeWidth={2}
                />
                <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={12} fontFamily="sans-serif">
                  {marker.label ?? marker.id}
                </text>
              </g>
            );
          })}
        </g>
        <g data-testid="trains">
          {renderTrains(trains, trainStatuses, markerPositions, edgeIndex, markerTangents)}
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
          transform={`translate(${x},${y}) rotate(${angleDeg})`}
        />
        <text
          x={x}
          y={y - TRAIN_HALF_L - MARKER_RADIUS * 0.5}
          textAnchor="middle"
          fontSize={11}
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
