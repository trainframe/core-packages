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
 * True when two pieces form a BRIDGE: coincident footprints (centres within
 * `OVERLAP_CENTRE_DISTANCE_MM`) on DIFFERENT height layers with no shared joint —
 * the track passing over itself, grade-separated. The exact complement of
 * `isInvalidOverlap`'s same-layer case: same coincidence test, opposite layer test.
 */
function isBridge(a: TrackPiece, b: TrackPiece): boolean {
  if (layerOf(a) === layerOf(b)) return false; // same layer — not a bridge
  if (centreDistance(a, b) > OVERLAP_CENTRE_DISTANCE_MM) return false; // apart
  if (shareEndpoint(a, b)) return false; // an end-to-end ramp joint, not a crossing
  return true;
}

/**
 * How many grade-separated crossings (bridges) a layout contains — coincident
 * footprints on different layers. A layout with no deliberate flyover returns 0; a
 * single self-crossing teardrop returns 1. Pairs with the same-layer overlap check:
 * `detectSameLayerOverlaps` must be empty (no foul) AND this counts the intended
 * bridges (a build-time guard that a flyover is really grade-separated, not flat).
 */
export function countBridges(pieces: ReadonlyArray<TrackPiece>): number {
  const track = pieces.filter((p) => !isDevicePiece(p.type));
  let n = 0;
  for (let i = 0; i < track.length; i++) {
    const a = track[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < track.length; j++) {
      const b = track[j];
      if (b !== undefined && isBridge(a, b)) n++;
    }
  }
  return n;
}

/**
 * The pier point (the raised piece's centre) counts as "over" a lower piece when
 * it lands within this distance (mm) of that piece's rail centre-line. A plank is
 * `2 × PLANK_HALF_WIDTH` (26 mm) wide and the pier ~9 mm, so half the plank plus
 * half the pier (~17.5 mm) plus a small cushion is the band where a column would
 * actually sit on the rail below. NOT a centre-to-centre test — a perpendicular
 * crossing's two centres can be 100 mm apart along the lower rail while the pier
 * point sits squarely on it.
 */
const PIER_OVER_RAIL_MM = 20;

/** Distance from point P to the line segment A→B. */
function pointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Proper segment-segment intersection, strictly INTERIOR to both (a shared
 *  endpoint or a T-touch is not a crossing). */
function segmentsCross(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): boolean {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return false; // parallel
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  const e = 1e-3;
  return t > e && t < 1 - e && u > e && u < 1 - e;
}

/** A piece's rail leg(s) as endpoint chords — one for a straight/curve/ramp, two
 *  (trunk→through, trunk→branch) for a turnout. */
function chordsOf(p: TrackPiece): { layer: number; a: LocalPt; b: LocalPt }[] {
  const eps = getEndpoints(p);
  const layer = layerOf(p);
  if (p.type === 'junction' && eps.length >= 3) {
    const [trunk, thru, branch] = eps;
    if (trunk && thru && branch)
      return [
        { layer, a: trunk, b: thru },
        { layer, a: trunk, b: branch },
      ];
  }
  const [a, b] = eps;
  return a && b ? [{ layer, a, b }] : [];
}

interface LocalPt {
  readonly x: number;
  readonly y: number;
}

interface Chord {
  readonly layer: number;
  readonly a: LocalPt;
  readonly b: LocalPt;
}

/** True when two chords share an endpoint (the pieces are joined, not crossing). */
function chordsShareEnd(a: Chord, b: Chord): boolean {
  for (const ea of [a.a, a.b])
    for (const eb of [b.a, b.b])
      if (Math.hypot(ea.x - eb.x, ea.y - eb.y) <= OVERLAP_SHARED_ENDPOINT_MM) return true;
  return false;
}

/** True when any same-layer leg of piece A crosses any same-layer leg of piece B
 *  (interior intersection, not a shared joint). */
function legsCross(as: readonly Chord[], bs: readonly Chord[]): boolean {
  for (const ca of as) {
    for (const cb of bs) {
      if (ca.layer !== cb.layer) continue;
      if (chordsShareEnd(ca, cb)) continue;
      if (segmentsCross(ca.a, ca.b, cb.a, cb.b)) return true;
    }
  }
  return false;
}

/**
 * The ids of track pieces whose rail centre-lines CROSS on the SAME layer without
 * sharing a joint — a true track-over-track foul (two trains would collide). This
 * is the complement of `detectSameLayerOverlaps`, which only catches pieces dropped
 * ON each other (centres close): two long pieces can cross with their centres far
 * apart, which that test misses entirely. Crossings on DIFFERENT layers (a bridge)
 * are valid and never flagged. Uses endpoint chords — exact for straights, a close
 * approximation for curves — so adjacent curves of a hump (which share endpoints)
 * are excluded and never false-positive.
 */
export function detectSameLayerCrossings(pieces: ReadonlyArray<TrackPiece>): Set<string> {
  const legs = pieces
    .filter((p) => !isDevicePiece(p.type))
    .map((p) => ({ id: p.id, chords: chordsOf(p) }));
  const flagged = new Set<string>();
  for (let i = 0; i < legs.length; i++) {
    const A = legs[i];
    if (A === undefined) continue;
    for (let j = i + 1; j < legs.length; j++) {
      const B = legs[j];
      if (B !== undefined && legsCross(A.chords, B.chords)) {
        flagged.add(A.id);
        flagged.add(B.id);
      }
    }
  }
  return flagged;
}

/**
 * True when a raised piece's support pier should be SUPPRESSED because track
 * runs directly beneath it. This is the bridge-crossing case: the deck spans
 * *over* the lower rail, so its piers belong beside the span, never planted on
 * the track passing underneath.
 *
 * The pier is a point under the deck's centre, so the test is whether that point
 * lies over a lower piece's BODY — point-to-centre-line distance against the
 * segments from the lower piece's centre out to each of its endpoints (exact for
 * a straight, a close chord approximation for a curve/junction). A centre-to-
 * centre test would miss a perpendicular crossing, where the lower rail's centre
 * is offset along its own length while the pier point sits on the rail.
 *
 * Ground-layer and device pieces never carry a pier and always return false.
 */
export function pierSuppressed(piece: TrackPiece, pieces: ReadonlyArray<TrackPiece>): boolean {
  const layer = layerOf(piece);
  if (layer <= 0 || isDevicePiece(piece.type)) return false;
  const px = piece.position.x;
  const py = piece.position.y; // the pier point
  for (const other of pieces) {
    if (other.id === piece.id) continue;
    if (isDevicePiece(other.type)) continue;
    if (layerOf(other) >= layer) continue; // only track BELOW this deck blocks a pier
    const { x: cx, y: cy } = other.position;
    for (const ep of getEndpoints(other)) {
      if (pointToSegment(px, py, cx, cy, ep.x, ep.y) <= PIER_OVER_RAIL_MM) return true;
    }
  }
  return false;
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
