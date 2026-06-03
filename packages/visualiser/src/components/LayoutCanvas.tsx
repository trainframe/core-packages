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
import { trainColor } from '../train-color.js';

interface Point {
  readonly x: number;
  readonly y: number;
}

const VIEWBOX = 600;
const CENTER = VIEWBOX / 2;
const RADIUS = CENTER - 60;
const MARKER_RADIUS = 14;
const TRAIN_RADIUS = 9;

/**
 * SVG visualisation of the active layout. Markers are placed in a circle
 * (auto-layout) when their spatial position isn't supplied; otherwise, the
 * marker's `position.x_mm` / `position.y_mm` is used directly. Edges are
 * straight lines between marker centers; trains render as filled circles at
 * the marker they last reported traversing.
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
            return (
              <line
                key={key}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={clearedTo ? trainColor(clearedTo) : edge.inferred ? '#aaa' : '#888'}
                strokeWidth={clearedTo ? 6 : 3}
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

function renderTrains(
  trains: TrainPositions,
  statuses: TrainStatuses,
  markerPositions: Map<string, Point>,
  edgeIndex: Map<string, VisualiserEdge>,
) {
  const out: JSX.Element[] = [];
  const trainIds = new Set<string>([...trains.keys(), ...statuses.keys()]);

  for (const trainId of trainIds) {
    const placement = placeTrain(trainId, trains, statuses, markerPositions, edgeIndex);
    if (!placement) continue;
    const { x, y, atMarker, onEdge } = placement;
    out.push(
      <g
        key={trainId}
        data-train-id={trainId}
        {...(atMarker ? { 'data-at-marker': atMarker } : {})}
        {...(onEdge ? { 'data-on-edge': onEdge } : {})}
      >
        <circle cx={x} cy={y} r={TRAIN_RADIUS} fill="#1f77b4" stroke="#0b3d68" strokeWidth={2} />
        <text
          x={x}
          y={y - MARKER_RADIUS - 6}
          textAnchor="middle"
          fontSize={11}
          fontFamily="sans-serif"
          fill="#0b3d68"
        >
          {trainId}
        </text>
      </g>,
    );
  }
  return out;
}

interface TrainPlacement extends Point {
  readonly atMarker?: string;
  readonly onEdge?: string;
}

/**
 * Prefer the latest `train_status` for mid-edge interpolation. Fall back to
 * the last `marker_traversed` snap-to-marker when status hasn't arrived yet.
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
      const edge = edgeIndex.get(edgeKey(status.current_edge));
      const length = edge?.estimated_length_mm;
      const distance = status.distance_into_edge_mm ?? 0;
      const t = length && length > 0 ? Math.min(1, Math.max(0, distance / length)) : 0;
      return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        onEdge: edgeKey(status.current_edge),
      };
    }
  }

  const markerId = trains.get(trainId);
  if (markerId) {
    const p = markerPositions.get(markerId);
    if (p) return { x: p.x, y: p.y, atMarker: markerId };
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
