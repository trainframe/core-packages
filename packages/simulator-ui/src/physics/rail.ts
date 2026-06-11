/**
 * A traversable world-space rail, composed from real placed track pieces.
 *
 * ADR-030: the simulator's physical layer follows the geometry the PIECES
 * self-report (`getCentreLinePath`), not bespoke hand-authored paths. A `Rail`
 * is one continuous centre-line a body can drive along — built by stitching an
 * ordered chain of pieces end-to-end (entry endpoint → centre → exit endpoint
 * per piece). It also reports the **curvature** at any point (so the physics can
 * derail a body that takes a curve too fast) and the **slope** (so a ramp can
 * accelerate a body under gravity).
 *
 * Pure geometry, DOM-free — unit-tested headless. The React layer only ever
 * reads body world poses; it never computes them.
 */

import { SNAP_DISTANCE_MM } from '../track/layout-from-pieces.js';
import {
  type CentreLinePath,
  type RailPose,
  type TrackPiece,
  getCentreLinePath,
  getEndpoints,
} from '../track/pieces.js';

/** Reverse a world path: sample from the far end, flip heading 180°. */
function reverse(path: CentreLinePath): CentreLinePath {
  return {
    length: path.length,
    at(d: number): RailPose {
      const p = path.at(path.length - Math.max(0, Math.min(path.length, d)));
      return { x: p.x, y: p.y, headingDeg: (p.headingDeg + 180) % 360 };
    },
  };
}

/** Chain world paths end-to-end; arc length is the running sum. */
function concat(parts: readonly CentreLinePath[]): CentreLinePath {
  const length = parts.reduce((s, p) => s + p.length, 0);
  return {
    length,
    at(d: number): RailPose {
      let r = Math.max(0, Math.min(length, d));
      for (const part of parts) {
        if (r <= part.length) return part.at(r);
        r -= part.length;
      }
      const last = parts.at(-1);
      return last ? last.at(last.length) : { x: 0, y: 0, headingDeg: 0 };
    },
  };
}

/** The endpoint index of `a` whose world position coincides with an endpoint of
 *  `b` (the shared joint), or undefined when the two pieces don't touch. */
function jointEndpointIndex(a: TrackPiece, b: TrackPiece): number | undefined {
  const epsA = getEndpoints(a);
  const epsB = getEndpoints(b);
  let best: number | undefined;
  let bestDist = SNAP_DISTANCE_MM;
  for (let i = 0; i < epsA.length; i++) {
    const ea = epsA[i];
    if (ea === undefined) continue;
    for (const eb of epsB) {
      if (eb === undefined) continue;
      const d = Math.hypot(ea.x - eb.x, ea.y - eb.y);
      if (d <= bestDist) {
        bestDist = d;
        best = i;
      }
    }
  }
  return best;
}

/** The piece's traversal path from its `entryIdx` endpoint to its `exitIdx`
 *  endpoint, through the centre: reverse(centre→entry) then centre→exit. */
function pieceTraversal(piece: TrackPiece, entryIdx: number, exitIdx: number): CentreLinePath {
  const toEntry = getCentreLinePath(piece, entryIdx);
  const toExit = getCentreLinePath(piece, exitIdx);
  if (toEntry === undefined || toExit === undefined) {
    // Degenerate piece (no centre-line for an endpoint): a zero-length stub.
    return { length: 0, at: () => ({ x: piece.position.x, y: piece.position.y, headingDeg: 0 }) };
  }
  return concat([reverse(toEntry), toExit]);
}

export interface Rail {
  /** Total drivable length (mm) along the chain. */
  readonly length: number;
  /** World pose `d` mm from the rail start (heading in the +d travel direction). */
  at(d: number): RailPose;
  /** Signed curvature (1/mm) at `d` — |κ|·v² is the lateral acceleration a body
   *  feels here; the physics derails it when that exceeds a limit. */
  curvatureAt(d: number): number;
  /** The track-piece type at `d` (e.g. 'ramp' adds gravity; 'terminus' buffers). */
  pieceTypeAt(d: number): string;
  /** Slope at `d`: +1 where the rail climbs in the +d direction (a ramp ascended),
   *  -1 where it descends, 0 on the level. Gravity uses this — a body works harder
   *  (slower) going up and runs a little faster coming down. */
  slopeAt(d: number): number;
  /** Whether each rail end is a buffer (terminus → a body stops) or open (a body
   *  runs off into free space). */
  readonly startBuffered: boolean;
  readonly endBuffered: boolean;
}

/**
 * Build one continuous world rail from an ordered chain of placed pieces. The
 * chain must be physically connected (consecutive pieces share a joint); the
 * first piece is entered by its free (non-joined) endpoint and the last left by
 * its free endpoint, so the rail spans the whole chain end to end.
 */
interface RailSegment {
  readonly traversal: CentreLinePath;
  readonly type: string;
  readonly slope: number;
}

/** The traversal path + type + slope for one piece in the chain, given its
 *  neighbours, or null for a degenerate (zero-traversal) piece. */
function segmentOf(
  piece: TrackPiece,
  prev: TrackPiece | undefined,
  next: TrackPiece | undefined,
): RailSegment | null {
  const entryFromPrev = prev ? jointEndpointIndex(piece, prev) : undefined;
  const exitToNext = next ? jointEndpointIndex(piece, next) : undefined;
  const epCount = getEndpoints(piece).length;
  const other = (j: number | undefined): number => {
    for (let k = 0; k < epCount; k++) if (k !== j) return k;
    return 0;
  };
  const entryIdx = entryFromPrev ?? other(exitToNext);
  const exitIdx = exitToNext ?? other(entryFromPrev);
  if (entryIdx === exitIdx) return null;
  // A ramp's higher endpoint is its `layerDelta` end (index 1, RAMP_ENDPOINTS).
  // Exiting via index 1 means the rail climbs in +d (+1); via 0 it descends (-1).
  const slope = piece.type === 'ramp' ? (exitIdx === 1 ? 1 : -1) : 0;
  return { traversal: pieceTraversal(piece, entryIdx, exitIdx), type: piece.type, slope };
}

export function buildRail(pieces: ReadonlyArray<TrackPiece>): Rail {
  const traversals: CentreLinePath[] = [];
  const segs: { type: string; start: number; end: number; slope: number }[] = [];
  let acc = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === undefined) continue;
    const seg = segmentOf(piece, i > 0 ? pieces[i - 1] : undefined, pieces[i + 1]);
    if (seg === null) continue;
    segs.push({ type: seg.type, start: acc, end: acc + seg.traversal.length, slope: seg.slope });
    acc += seg.traversal.length;
    traversals.push(seg.traversal);
  }
  const path = concat(traversals);
  const EPS = 0.5;
  const first = pieces[0];
  const last = pieces.at(-1);
  return {
    length: path.length,
    at: (d) => path.at(d),
    pieceTypeAt(d: number): string {
      const seg = segs.find((s) => d >= s.start && d <= s.end);
      return seg?.type ?? 'straight';
    },
    slopeAt(d: number): number {
      const seg = segs.find((s) => d >= s.start && d <= s.end);
      return seg?.slope ?? 0;
    },
    startBuffered: first?.type === 'terminus',
    endBuffered: last?.type === 'terminus',
    curvatureAt(d: number): number {
      // dHeading/dLength, central difference. Headings wrap at 360.
      const a = path.at(Math.max(0, d - EPS)).headingDeg;
      const b = path.at(Math.min(path.length, d + EPS)).headingDeg;
      const dh = ((b - a + 540) % 360) - 180; // shortest signed delta, degrees
      const ds = Math.min(path.length, d + EPS) - Math.max(0, d - EPS);
      if (ds <= 0) return 0;
      return (dh * Math.PI) / 180 / ds; // radians per mm = 1/radius
    },
  };
}
