/** Re-export for convenience; the scheduler uses these constantly. */
export interface EdgeRef {
  from_marker_id: string;
  to_marker_id: string;
}

export const edgesEqual = (a: EdgeRef, b: EdgeRef): boolean =>
  a.from_marker_id === b.from_marker_id && a.to_marker_id === b.to_marker_id;

/** Two sections conflict when they share either boundary marker (ADR-011). */
export function edgeSharesMarker(a: EdgeRef, b: EdgeRef): boolean {
  return (
    a.from_marker_id === b.from_marker_id ||
    a.from_marker_id === b.to_marker_id ||
    a.to_marker_id === b.from_marker_id ||
    a.to_marker_id === b.to_marker_id
  );
}

export function anyEdgeSharesMarker(held: ReadonlyArray<EdgeRef>, wanted: EdgeRef): boolean {
  for (const e of held) {
    if (edgeSharesMarker(e, wanted)) return true;
  }
  return false;
}
