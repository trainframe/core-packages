/**
 * Composite rail path for a logical edge A→B.
 *
 * A scheduler edge runs from one piece's marker (its centre) to an adjacent
 * piece's marker. The two pieces meet at a shared joint — the coincident pair
 * of their endpoints. The rail a train actually rides over that edge is:
 *
 *     A.centre → jointA   then   jointB → B.centre
 *
 * built from each piece's true centre-line geometry (arc for curves, straight
 * otherwise) rather than the chord between the two centres. This is what lets a
 * train visibly follow a bend, take the correct junction leg, and carry the
 * right heading instead of cutting the corner.
 *
 * The joint is found purely geometrically (closest endpoint pair within
 * `SNAP_DISTANCE`), so a junction's through-vs-branch leg is selected by which
 * endpoint coincides with the neighbour — no switch-position lookup needed; the
 * scheduler already terminates the edge at the right junction endpoint.
 *
 * Pure geometry: `(pieceA, pieceB) → sampleable path`. No React, no I/O.
 */

import { carriageWorldPos } from './coupling.js';
import { SNAP_DISTANCE } from './layout-from-pieces.js';
import {
  type CentreLinePath,
  type RailPose,
  type TrackPiece,
  getCentreLinePath,
  getEndpoints,
} from './pieces.js';

/**
 * A world-space rail path for the edge A→B. `length` is the true composite rail
 * length in mm (A's half + B's half). `at(d)` samples `d` mm from A's centre
 * toward B's centre; the joint is at `d = lengthA` (NOT `length / 2`). Heading
 * is continuous in the A→B travel direction.
 */
export interface EdgePath {
  readonly length: number;
  at(distFromStart: number): RailPose;
}

function normaliseAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** The (indexA, indexB) endpoints of A and B that coincide at the shared joint,
 * or `undefined` when no endpoint pair is within `SNAP_DISTANCE`. Only ever
 * called on the two pieces of an already-compiled edge (same layer except a
 * ramp, whose two ends are 200mm apart and so never both within SNAP_DISTANCE
 * of the neighbour), so it needs no layer gate. */
function findJoint(
  a: TrackPiece,
  b: TrackPiece,
): { readonly indexA: number; readonly indexB: number } | undefined {
  const epsA = getEndpoints(a);
  const epsB = getEndpoints(b);
  let best: { indexA: number; indexB: number } | undefined;
  let bestDist = SNAP_DISTANCE;
  for (let i = 0; i < epsA.length; i++) {
    const ea = epsA[i];
    if (ea === undefined) continue;
    for (let j = 0; j < epsB.length; j++) {
      const eb = epsB[j];
      if (eb === undefined) continue;
      const d = Math.hypot(ea.x - eb.x, ea.y - eb.y);
      if (d <= bestDist) {
        bestDist = d;
        best = { indexA: i, indexB: j };
      }
    }
  }
  return best;
}

/**
 * A straight centre→centre fallback path between two piece positions. Used when
 * no coincident endpoint can be found (pieces not actually adjacent) so the
 * renderer always has something to sample and can never throw. Heading is the
 * constant A→B direction.
 */
function chordPath(a: TrackPiece, b: TrackPiece): EdgePath {
  const length = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y);
  return {
    length,
    at(distFromStart: number): RailPose {
      // The straight-line lerp + atan2 heading is exactly carriageWorldPos.
      const wp = carriageWorldPos(a.position, b.position, length, distFromStart);
      return { x: wp.x, y: wp.y, headingDeg: normaliseAngle(wp.rotationDeg) };
    },
  };
}

/**
 * Compose the world-space rail path for the edge from piece `a` (start marker)
 * to piece `b` (end marker). When the two pieces share a joint, the path is
 * A's centre-line out to the joint followed by B's centre-line *into* B's
 * centre (B's half reversed, heading flipped 180° so travel stays A→B). When no
 * joint is found it falls back to the straight chord between the two centres.
 *
 * @pure
 */
export function composeEdgePath(a: TrackPiece, b: TrackPiece): EdgePath {
  const joint = findJoint(a, b);
  if (joint === undefined) return chordPath(a, b);

  const halfA = getCentreLinePath(a, joint.indexA);
  const halfB = getCentreLinePath(b, joint.indexB);
  if (halfA === undefined || halfB === undefined) return chordPath(a, b);

  return composeHalves(halfA, halfB);
}

/** Stitch A's half (centre→joint) to B's half traversed joint→centre. */
function composeHalves(halfA: CentreLinePath, halfB: CentreLinePath): EdgePath {
  const lenA = halfA.length;
  const length = lenA + halfB.length;
  return {
    length,
    at(distFromStart: number): RailPose {
      if (distFromStart <= lenA) {
        return halfA.at(distFromStart);
      }
      // Second half: travel from the joint (B's endpoint) toward B's centre.
      // B's half is defined centre→endpoint, so we sample it from its far end
      // inward and flip the heading 180° to keep travel in the A→B direction.
      const intoB = distFromStart - lenA; // 0 at joint … halfB.length at B.centre
      const pose = halfB.at(Math.max(0, halfB.length - intoB));
      return { x: pose.x, y: pose.y, headingDeg: normaliseAngle(pose.headingDeg + 180) };
    },
  };
}
