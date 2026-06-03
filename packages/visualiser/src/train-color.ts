/**
 * Derive a stable hue from a train ID. The hue is deterministic so the same
 * train always gets the same colour across re-renders and page refreshes.
 *
 * Uses FNV-1a hashing (32-bit) combined with the golden-ratio conjugate
 * multiplier (≈ 0.618 of 360°) so that short IDs differing in a single
 * character — "T1" vs "T2" vs "T3" — land at widely separated hues, not
 * clustered together as a naïve polynomial hash would. Returns a value in
 * [0, 360) suitable for use directly in `hsl(hue, …)`.
 */
export function trainHue(trainId: string): number {
  // FNV-1a 32-bit: small offset basis xor'd with each char, then mul by
  // the FNV prime. A single-character change cascades through every bit
  // of the output.
  let hash = 0x811c9dc5;
  for (let i = 0; i < trainId.length; i++) {
    hash ^= trainId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Spread adjacent hash values around the hue circle via the golden
  // ratio conjugate. Multiplying by (√5 − 1)/2 ≈ 0.61803 maximises the
  // angular distance between any small set of inputs, so the first few
  // train IDs get visually distinct colours.
  const u32 = hash >>> 0;
  return Math.floor((u32 * 0.6180339887498949 * 360) % 360);
}

/**
 * Return a CSS `hsl(…)` colour string for the given train ID.
 * Saturation and lightness are fixed to stay legible on both white and
 * dark backgrounds; phase 4 can parameterise them.
 */
export function trainColor(trainId: string): string {
  return `hsl(${trainHue(trainId)}, 70%, 45%)`;
}
