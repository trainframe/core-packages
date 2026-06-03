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
 * Fraction of the edge half-length used as the perpendicular bezier offset.
 * Larger values give more pronounced curves; 0.25 gives a gentle arc.
 */
const BEZIER_OFFSET_FRACTION = 0.25;

/**
 * Compute the two cubic bezier control points for a gently curved edge.
 * The control points are offset perpendicularly from the midpoint of the
 * straight line, creating a smooth arc. Alternating sign per edge key keeps
 * adjacent bidirectional edges visually separated.
 */
function edgeBezierControls(from: Point, to: Point, edgeKey: string): { c1: Point; c2: Point } {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { c1: from, c2: to };

  // Perpendicular unit vector.
  const px = -dy / len;
  const py = dx / len;

  // Use a hash of the edge key to get a consistent sign so forward/reverse
  // edges of the same pair curve to opposite sides.
  let keyHash = 0;
  for (let i = 0; i < edgeKey.length; i++) {
    keyHash = (keyHash * 31 + edgeKey.charCodeAt(i)) | 0;
  }
  const sign = keyHash % 2 === 0 ? 1 : -1;
  const offset = len * BEZIER_OFFSET_FRACTION * sign;

  // One control point each side of the midpoint, offset perpendicularly.
  const cpx = mx + px * offset;
  const cpy = my + py * offset;

  // For a symmetric arc, both control points are the same midpoint-offset.
  return { c1: { x: cpx, y: cpy }, c2: { x: cpx, y: cpy } };
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
 * Build an SVG `<path>` `d` for the 5-point train body shape.
 *
 * The shape (in local coordinates, before rotation):
 *   - Tip at (halfL, 0) — front, pointing right
 *   - Shoulders at (shX, ±shY)  — just behind the tip
 *   - Rear corners at (-halfL, ±halfW)
 *   - Q-curve from shoulder to rear corner gives smooth hull sides
 *
 * After building the path we transform it via a rotate + translate.
 */
function trainShapeD(halfL: number, halfW: number): string {
  const tipX = halfL;
  const shX = halfL * 0.35;
  const shY = halfW * 0.6;
  const rearX = -halfL;
  const rearY = halfW;

  // Start at tip, Q-curve through shoulder to rear-right corner,
  // straight across the back, Q-curve up to left shoulder, close at tip.
  return [
    `M ${tipX} 0`,
    `Q ${shX} ${shY}, ${rearX} ${rearY}`,
    `L ${rearX} ${-rearY}`,
    `Q ${shX} ${-shY}, ${tipX} 0`,
    'Z',
  ].join(' ');
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
          {layout.edges.map((edge) => {
            const from = markerPositions.get(edge.from_marker_id);
            const to = markerPositions.get(edge.to_marker_id);
            if (!from || !to) return null;
            const key = `${edge.from_marker_id}->${edge.to_marker_id}`;
            const clearedTo = clearanceMap.get(key) ?? '';
            const { c1, c2 } = edgeBezierControls(from, to, key);
            const d = bezierPathD(from, to, c1, c2);
            return (
              <path
                key={key}
                d={d}
                fill="none"
                stroke={clearedTo ? trainColor(clearedTo) : edge.inferred ? '#aaa' : '#888'}
                strokeWidth={clearedTo ? 9 : 6}
                strokeLinecap="round"
                data-cleared-to={clearedTo}
                {...(edge.inferred && !clearedTo
                  ? { strokeDasharray: '8 6', 'data-inferred': 'true' }
                  : {})}
              />
            );
          })}
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
          {renderTrains(trains, trainStatuses, markerPositions, edgeIndex)}
        </g>
      </svg>
    </section>
  );
}

/** Half-length and half-width of the train shape in SVG units. */
const TRAIN_HALF_L = MARKER_RADIUS * 1.1;
const TRAIN_HALF_W = MARKER_RADIUS * 0.55;

const TRAIN_SHAPE_D = trainShapeD(TRAIN_HALF_L, TRAIN_HALF_W);

function renderTrains(
  trains: TrainPositions,
  statuses: TrainStatuses,
  markerPositions: Map<string, Point>,
  edgeIndex: Map<string, VisualiserEdge>,
): JSX.Element[] {
  const out: JSX.Element[] = [];
  const trainIds = new Set<string>([...trains.keys(), ...statuses.keys()]);

  for (const trainId of trainIds) {
    const placement = placeTrain(trainId, trains, statuses, markerPositions, edgeIndex);
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
      const { c1, c2 } = edgeBezierControls(from, to, key);
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
