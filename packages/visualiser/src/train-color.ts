/**
 * Derive a stable hue from a train ID. The hue is deterministic so the same
 * train always gets the same colour across re-renders and page refreshes.
 *
 * The algorithm is a simple polynomial hash that spreads short IDs (T1, T2 …)
 * far enough apart that neighbouring trains look distinct. It returns a value
 * in [0, 360) suitable for use directly in `hsl(hue, …)`.
 */
export function trainHue(trainId: string): number {
  let hash = 0;
  for (let i = 0; i < trainId.length; i++) {
    // Multiply-add hash — fast and good enough for the handful of IDs we have.
    hash = (hash * 31 + trainId.charCodeAt(i)) | 0;
  }
  // Keep positive and map into [0, 360).
  return ((hash % 360) + 360) % 360;
}

/**
 * Return a CSS `hsl(…)` colour string for the given train ID.
 * Saturation and lightness are fixed to stay legible on both white and
 * dark backgrounds; phase 4 can parameterise them.
 */
export function trainColor(trainId: string): string {
  return `hsl(${trainHue(trainId)}, 70%, 45%)`;
}
