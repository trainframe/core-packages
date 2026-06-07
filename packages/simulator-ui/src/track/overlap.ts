/**
 * Same-layer track-on-track overlap detection.
 *
 * A legitimate Brio table never stacks two track pieces on the SAME layer at
 * the same spot: pieces either connect end-to-end (sharing an endpoint) or sit
 * apart. Two same-layer pieces whose bodies coincide but share NO endpoint is an
 * authoring mistake — the operator dropped one piece on top of another. (Two
 * pieces at the same 2D spot on DIFFERENT layers is the opposite: that's exactly
 * how a bridge crosses over a ground track, and must NOT be flagged.)
 *
 * This is pure geometry over the compiled piece poses — no React, no I/O — so it
 * can be unit-tested directly and called each render to drive a visible warning.
 */

import { type TrackPiece, getEndpoints, isDevicePiece, layerOf } from './pieces.js';

/**
 * Two pieces' centres within this distance (mm) are treated as bodies
 * occupying the same footprint. Generous enough to catch a piece dropped a few
 * mm off another, tight enough that two adjacent ~200mm pieces (centres ~200mm
 * apart) are never considered coincident.
 */
export const OVERLAP_CENTRE_DISTANCE_MM = 60;

/**
 * Two endpoints within this distance (mm) are "shared" — the same physical
 * join. Matches `SNAP_DISTANCE_MM` in the layout compiler so detection agrees
 * with what actually clusters into one marker.
 */
export const OVERLAP_SHARED_ENDPOINT_MM = 30;

function centreDistance(a: TrackPiece, b: TrackPiece): number {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** True when pieces a and b have any endpoint pair within the shared-endpoint
 * distance (i.e. they legitimately connect end-to-end). */
function shareEndpoint(a: TrackPiece, b: TrackPiece): boolean {
  const aps = getEndpoints(a);
  const bps = getEndpoints(b);
  for (const ea of aps) {
    for (const eb of bps) {
      const dx = ea.x - eb.x;
      const dy = ea.y - eb.y;
      if (Math.sqrt(dx * dx + dy * dy) <= OVERLAP_SHARED_ENDPOINT_MM) return true;
    }
  }
  return false;
}

/**
 * True when two track pieces form an INVALID same-layer overlap: same layer,
 * coincident bodies (centres within `OVERLAP_CENTRE_DISTANCE_MM`), and no shared
 * endpoint. Different layers (a bridge) or a shared end-to-end join are valid.
 */
function isInvalidOverlap(a: TrackPiece, b: TrackPiece): boolean {
  if (layerOf(a) !== layerOf(b)) return false; // a bridge crossing — valid
  if (centreDistance(a, b) > OVERLAP_CENTRE_DISTANCE_MM) return false; // apart — valid
  if (shareEndpoint(a, b)) return false; // connected end-to-end — valid
  return true;
}

/**
 * The ids of track pieces involved in an invalid same-layer overlap (see
 * `isInvalidOverlap`). Device pieces (trains, gates, carriages) are ignored —
 * they ride on top of track by design and contribute no topology.
 *
 * Returns the set of offending piece ids (both members of every bad pair), so
 * the renderer can outline exactly the pieces at fault.
 */
export function detectSameLayerOverlaps(pieces: ReadonlyArray<TrackPiece>): Set<string> {
  const track = pieces.filter((p) => !isDevicePiece(p.type));
  const flagged = new Set<string>();
  for (let i = 0; i < track.length; i++) {
    const a = track[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < track.length; j++) {
      const b = track[j];
      if (b === undefined) continue;
      if (isInvalidOverlap(a, b)) {
        flagged.add(a.id);
        flagged.add(b.id);
      }
    }
  }
  return flagged;
}
