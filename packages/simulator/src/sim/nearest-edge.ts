import type { Layout, LayoutEdge, LayoutMarker } from '@trainframe/protocol';

/** A unit-ish heading vector in table mm-space (SVG, +y down) — the direction a
 *  placed train faces. Needn't be normalised; only its direction is used. */
export interface Facing {
  readonly x: number;
  readonly y: number;
}

/**
 * Pick the edge a freshly-scanned train should start on, given where the
 * operator dropped the train piece on the toy-table AND which way it faces.
 *
 * Algorithm:
 *  1. Find the marker in `layout` whose centroid (mm) is closest to the train
 *     piece position — the marker the train sits on.
 *  2. Among edges that originate at that marker (`from_marker_id === M`):
 *     - if a `facing` is given, pick the edge whose geometric direction (from
 *       this marker toward its neighbour, computed from the markers' positions)
 *       best matches the facing — so a placed loco departs the way it POINTS,
 *       never flipping 180°. Ties (and missing neighbour positions) fall back
 *       to a deterministic `to_marker_id` sort;
 *     - with no facing, pick deterministically (sorted by `to_marker_id`).
 *  3. If no outgoing edge exists from the nearest marker, return `undefined`
 *     so the caller can defer spawning.
 *
 * The facing comes from the train piece's own orientation; the forward edge is
 * derived purely from marker geometry. Nothing here reaches into the scheduler
 * or invents a heading the device couldn't itself declare.
 *
 * Markers without a `position` are treated as infinitely far away — they're
 * still recorded in the layout but can't anchor a physical drop.
 */
export function nearestStartEdge(
  layout: Layout,
  position: { readonly x: number; readonly y: number },
  facing?: Facing,
): { from_marker_id: string; to_marker_id: string } | undefined {
  const marker = nearestPositionedMarker(layout.markers, position);
  if (marker === undefined) return undefined;
  const markerById = new Map(layout.markers.map((m) => [m.id, m] as const));
  const candidates = layout.edges
    .filter((e: LayoutEdge) => e.from_marker_id === marker.id)
    .slice()
    .sort((a, b) =>
      a.to_marker_id < b.to_marker_id ? -1 : a.to_marker_id > b.to_marker_id ? 1 : 0,
    );
  const first = candidates[0];
  if (first === undefined) return undefined;

  // With a facing, prefer the outgoing edge most aligned with it. The sorted
  // order is the tiebreak, so this stays deterministic when alignment is equal
  // (or neighbour positions are missing → alignment 0 for all).
  const chosen =
    facing === undefined
      ? first
      : candidates.reduce((best, edge) => {
          const a = alignment(marker, markerById.get(edge.to_marker_id), facing);
          const bestA = alignment(marker, markerById.get(best.to_marker_id), facing);
          return a > bestA ? edge : best;
        }, first);

  return { from_marker_id: chosen.from_marker_id, to_marker_id: chosen.to_marker_id };
}

/** Dot product of the (from→to) edge direction with the facing — higher means
 *  the edge leaves the marker more nearly the way the train points. Returns 0
 *  when the neighbour has no position (so it never beats a real alignment). */
function alignment(from: LayoutMarker, to: LayoutMarker | undefined, facing: Facing): number {
  const a = from.position;
  const b = to?.position;
  if (a === undefined || b === undefined) return 0;
  const dx = b.x_mm - a.x_mm;
  const dy = b.y_mm - a.y_mm;
  const len = Math.hypot(dx, dy);
  if (len === 0) return 0;
  return (dx * facing.x + dy * facing.y) / len;
}

/**
 * The id of the layout marker whose centroid is closest to `position`, or
 * `undefined` if no marker has a position yet. Used to bind a device dropped
 * beside the track (e.g. a railyard) to the marker it acts on — its throat.
 */
export function nearestMarkerId(
  layout: Layout,
  position: { readonly x: number; readonly y: number },
): string | undefined {
  return nearestPositionedMarker(layout.markers, position)?.id;
}

function nearestPositionedMarker(
  markers: ReadonlyArray<LayoutMarker>,
  position: { readonly x: number; readonly y: number },
): LayoutMarker | undefined {
  let best: LayoutMarker | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const pos = marker.position;
    if (pos === undefined) continue;
    const dx = pos.x_mm - position.x;
    const dy = pos.y_mm - position.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      best = marker;
    }
  }
  return best;
}
