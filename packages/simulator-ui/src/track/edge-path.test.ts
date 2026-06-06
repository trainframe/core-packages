import { describe, expect, it } from 'vitest';
import { composeEdgePath } from './edge-path.js';
import { type RotationDeg, type TrackPiece, getEndpoints } from './pieces.js';
import { computePlacement } from './placement.js';

const EPS = 0.5;
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}
function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected defined value');
  return v;
}
/** Normalised absolute angular difference in degrees, in [0, 180]. */
function angleDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

function piece(
  id: string,
  type: TrackPiece['type'],
  x: number,
  y: number,
  rotationDeg: RotationDeg = 0,
  flipped = false,
): TrackPiece {
  return { id, type, position: { x, y }, rotationDeg, tagged: false, flipped };
}

/** Place a candidate of `type` snapped onto `anchor`'s open endpoint, returning
 * the resulting placed piece. Uses the real placement geometry. */
function placedSnappedTo(
  id: string,
  type: TrackPiece['type'],
  anchor: TrackPiece,
  flipped = false,
): TrackPiece {
  const ep = must(getEndpoints(anchor)[1]); // anchor's exit endpoint
  const placement = computePlacement(ep.x, ep.y, type, [anchor], flipped);
  expect(placement.connected).toBe(true);
  return {
    id,
    type,
    position: { x: placement.x, y: placement.y },
    rotationDeg: placement.rotationDeg,
    tagged: false,
    flipped,
  };
}

describe('composeEdgePath — two straights', () => {
  it('is the straight line between centres, joint at lengthA', () => {
    const a = piece('A', 'straight', 0, 0);
    const b = piece('B', 'straight', 200, 0); // exit of A == entry of B at (100,0)
    const path = composeEdgePath(a, b);
    expect(path.length).toBeCloseTo(200, 3);
    // Joint is at d = lengthA = 100, at world (100,0).
    const joint = path.at(100);
    expect(approx(joint.x, 100)).toBe(true);
    expect(approx(joint.y, 0)).toBe(true);
    expect(angleDelta(joint.headingDeg, 0)).toBeLessThan(0.5);
    // Endpoints land on the two centres.
    expect(approx(path.at(0).x, 0)).toBe(true);
    expect(approx(path.at(path.length).x, 200)).toBe(true);
  });
});

describe('composeEdgePath — DISCRIMINATING arc test (chord-cut is gone)', () => {
  // A straight at origin (exit at (100,0), heading east) and a curve snapped onto
  // it so the curve continues the rail. The shared joint lies OFF the straight
  // chord between the two piece centres (by the arc sagitta), and the heading at
  // the joint and mid-curve is the ARC TANGENT, not the chord direction.
  const straight = piece('S', 'straight', 0, 0);
  const curve = placedSnappedTo('C', 'curve', straight);

  it('renders the train at the JOINT (off the chord) at d = A half-length', () => {
    const path = composeEdgePath(straight, curve);
    const lenA = 100; // straight half
    const joint = path.at(lenA);
    // The joint is the straight's exit endpoint == the curve's entry endpoint.
    const exitOfStraight = must(getEndpoints(straight)[1]);
    expect(approx(joint.x, exitOfStraight.x)).toBe(true);
    expect(approx(joint.y, exitOfStraight.y)).toBe(true);

    // Prove it is OFF the straight chord between the two centres: the chord
    // from straight.centre to curve.centre, sampled at the same fraction, lands
    // somewhere different (the curve's centre is not collinear east).
    const chordY = (curve.position.y - straight.position.y) * (lenA / path.length);
    expect(Math.abs(joint.y - chordY)).toBeGreaterThan(5);
  });

  it('carries the ARC-TANGENT heading mid-curve, not the chord heading', () => {
    const path = composeEdgePath(straight, curve);
    const lenA = 100;
    // Midpoint of the curve half (just past the joint): heading must be turning
    // away from due-east. The chord between centres would give a constant angle;
    // the arc tangent rotates. Sample a little into the curve.
    const midCurve = path.at(lenA + 39); // ~mid of the 78.5mm arc half
    expect(angleDelta(midCurve.headingDeg, 0)).toBeGreaterThan(5);
    // The chord direction centre→centre, for reference, differs from the tangent.
    const chordHeading =
      (Math.atan2(curve.position.y - straight.position.y, curve.position.x - straight.position.x) *
        180) /
      Math.PI;
    expect(angleDelta(midCurve.headingDeg, chordHeading)).toBeGreaterThan(2);
  });
});

describe('composeEdgePath — flipped curve render', () => {
  it('mirrors the joint and heading when the curve is flipped', () => {
    const straight = piece('S', 'straight', 0, 0);
    const normal = placedSnappedTo('C', 'curve', straight, false);
    const flipped = placedSnappedTo('C', 'curve', straight, true);
    const pn = composeEdgePath(straight, normal);
    const pf = composeEdgePath(straight, flipped);
    // Sample a little into each curve half (just past the joint at d=100).
    const sn = pn.at(140);
    const sf = pf.at(140);
    // The straight's exit is the joint at (100,0); the flipped curve bends the
    // other way, so the y of the sampled point reflects across the joint line.
    expect(approx(sf.x, sn.x)).toBe(true);
    expect(approx(sf.y, -sn.y)).toBe(true);
    // Headings reflect across the east axis.
    expect(angleDelta(sf.headingDeg, -sn.headingDeg)).toBeLessThan(1);
  });
});

describe('composeEdgePath — rotated curve render', () => {
  it('rotates the joint and heading by the piece rotation', () => {
    // Straight rotated 90° (pointing south), curve snapped to continue it.
    const straight = piece('S', 'straight', 0, 0, 90);
    const curve = placedSnappedTo('C', 'curve', straight);
    const path = composeEdgePath(straight, curve);
    const joint = path.at(100);
    const exit = must(getEndpoints(straight)[1]); // straight's south exit, (0,100)
    expect(approx(joint.x, exit.x)).toBe(true);
    expect(approx(joint.y, exit.y)).toBe(true);
    // Travel direction at the joint is the straight's outgoing angle (south=90°).
    expect(angleDelta(joint.headingDeg, exit.outgoingAngleDeg)).toBeLessThan(0.5);
  });
});

describe('composeEdgePath — fallback when no joint', () => {
  it('falls back to the centre-to-centre chord when pieces are not adjacent', () => {
    const a = piece('A', 'straight', 0, 0);
    const b = piece('B', 'straight', 1000, 0); // far apart, no coincident endpoints
    const path = composeEdgePath(a, b);
    expect(path.length).toBeCloseTo(1000, 3);
    const mid = path.at(500);
    expect(approx(mid.x, 500)).toBe(true);
    expect(approx(mid.y, 0)).toBe(true);
  });
});
