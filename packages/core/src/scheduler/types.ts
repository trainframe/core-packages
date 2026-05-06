/** Re-export for convenience; the scheduler uses these constantly. */
export interface EdgeRef {
  from_marker_id: string;
  to_marker_id: string;
}

export const edgesEqual = (a: EdgeRef, b: EdgeRef): boolean =>
  a.from_marker_id === b.from_marker_id && a.to_marker_id === b.to_marker_id;
