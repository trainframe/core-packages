import type { Layout, LayoutEdge, LayoutMarker } from '@trainframe/protocol';

/**
 * Pick the edge a freshly-scanned train should start on, given where the
 * operator dropped the train piece on the toy-table.
 *
 * Algorithm:
 *  1. Find the marker in `layout` whose centroid (mm) is closest to the train
 *     piece position.
 *  2. Among edges that originate at that marker (`from_marker_id === M`),
 *     pick one deterministically (sorted by `to_marker_id`).
 *  3. If no outgoing edge exists from the nearest marker, return `undefined`
 *     so the caller can defer spawning.
 *
 * Markers without a `position` are treated as infinitely far away — they're
 * still recorded in the layout but can't anchor a physical drop.
 */
export function nearestStartEdge(
  layout: Layout,
  position: { readonly x: number; readonly y: number },
): { from_marker_id: string; to_marker_id: string } | undefined {
  const marker = nearestPositionedMarker(layout.markers, position);
  if (marker === undefined) return undefined;
  const candidates = layout.edges
    .filter((e: LayoutEdge) => e.from_marker_id === marker.id)
    .slice()
    .sort((a, b) =>
      a.to_marker_id < b.to_marker_id ? -1 : a.to_marker_id > b.to_marker_id ? 1 : 0,
    );
  const first = candidates[0];
  if (first === undefined) return undefined;
  return { from_marker_id: first.from_marker_id, to_marker_id: first.to_marker_id };
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
