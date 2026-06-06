import { describe, expect, it } from 'vitest';
import {
  type RotationDeg,
  type TrackPiece,
  getCentreLinePath,
  getEndpoints,
  getPieceShape,
  isDevicePiece,
  isWireDevice,
  pieceMarkerKind,
} from './pieces.js';

function makePiece(type: TrackPiece['type'], rotationDeg: RotationDeg = 0): TrackPiece {
  return { id: 'test', type, position: { x: 0, y: 0 }, rotationDeg, tagged: false };
}

// Tolerance for floating-point comparisons (mm).
const EPS = 0.5;

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected defined endpoint');
  return v;
}

describe('getEndpoints — straight', () => {
  it('returns 2 endpoints at rotation 0', () => {
    const eps = getEndpoints(makePiece('straight'));
    expect(eps).toHaveLength(2);
  });

  it('entry is at (-100, 0) with outgoing angle 180° at rotation 0', () => {
    const [entry] = getEndpoints(makePiece('straight'));
    expect(entry).toBeDefined();
    expect(approx(must(entry).x, -100)).toBe(true);
    expect(approx(must(entry).y, 0)).toBe(true);
    expect(must(entry).outgoingAngleDeg).toBe(180);
  });

  it('exit is at (100, 0) with outgoing angle 0° at rotation 0', () => {
    const [, exit] = getEndpoints(makePiece('straight'));
    expect(exit).toBeDefined();
    expect(approx(must(exit).x, 100)).toBe(true);
    expect(approx(must(exit).y, 0)).toBe(true);
    expect(must(exit).outgoingAngleDeg).toBe(0);
  });

  it('rotates endpoints correctly at 90°', () => {
    const eps = getEndpoints(makePiece('straight', 90));
    // At 90° rotation: (-100, 0) → (0, -100) and (100, 0) → (0, 100)
    expect(approx(must(eps[0]).x, 0)).toBe(true);
    expect(approx(must(eps[0]).y, -100)).toBe(true);
    expect(must(eps[0]).outgoingAngleDeg).toBe(270);
    expect(approx(must(eps[1]).x, 0)).toBe(true);
    expect(approx(must(eps[1]).y, 100)).toBe(true);
    expect(must(eps[1]).outgoingAngleDeg).toBe(90);
  });

  it('rotates endpoints correctly at 45°', () => {
    const eps = getEndpoints(makePiece('straight', 45));
    // At 45°: (-100,0) → ~(-70.7, -70.7)
    const sqrt2over2 = Math.SQRT2 / 2;
    expect(approx(must(eps[0]).x, -100 * sqrt2over2)).toBe(true);
    expect(approx(must(eps[0]).y, -100 * sqrt2over2)).toBe(true);
    expect(must(eps[0]).outgoingAngleDeg).toBe(225);
    expect(must(eps[1]).outgoingAngleDeg).toBe(45);
  });
});

describe('getEndpoints — curve', () => {
  it('returns 2 endpoints', () => {
    expect(getEndpoints(makePiece('curve'))).toHaveLength(2);
  });

  it('entry angle is 180° at rotation 0', () => {
    const [entry] = getEndpoints(makePiece('curve'));
    expect(must(entry).outgoingAngleDeg).toBe(180);
  });

  it('exit angle is 45° at rotation 0', () => {
    const [, exit] = getEndpoints(makePiece('curve'));
    expect(must(exit).outgoingAngleDeg).toBe(45);
  });

  it('angles shift by rotation at 90°', () => {
    const eps = getEndpoints(makePiece('curve', 90));
    expect(must(eps[0]).outgoingAngleDeg).toBe(270);
    expect(must(eps[1]).outgoingAngleDeg).toBe(135);
  });

  it('mirrors the bend when flipped (exit 45° → 315°, y negated)', () => {
    const normal = getEndpoints(makePiece('curve'));
    const flipped = getEndpoints({ ...makePiece('curve'), flipped: true });
    // Entry still faces west; exit bends the other way.
    expect(must(flipped[0]).outgoingAngleDeg).toBe(180);
    expect(must(flipped[1]).outgoingAngleDeg).toBe(315);
    // Each endpoint is reflected across the x-axis (y negated).
    expect(approx(must(flipped[0]).y, -must(normal[0]).y)).toBe(true);
    expect(approx(must(flipped[1]).y, -must(normal[1]).y)).toBe(true);
    expect(approx(must(flipped[1]).x, must(normal[1]).x)).toBe(true);
  });
});

describe('getEndpoints — junction', () => {
  it('returns 3 endpoints (trunk, through, branch)', () => {
    expect(getEndpoints(makePiece('junction'))).toHaveLength(3);
  });

  it('trunk at index 0 is at (-100, 0) with angle 180° at rotation 0', () => {
    const [trunk] = getEndpoints(makePiece('junction'));
    expect(approx(must(trunk).x, -100)).toBe(true);
    expect(approx(must(trunk).y, 0)).toBe(true);
    expect(must(trunk).outgoingAngleDeg).toBe(180);
  });

  it('through at index 1 is at (100, 0) with angle 0° at rotation 0', () => {
    const [, through] = getEndpoints(makePiece('junction'));
    expect(approx(must(through).x, 100)).toBe(true);
    expect(approx(must(through).y, 0)).toBe(true);
    expect(must(through).outgoingAngleDeg).toBe(0);
  });

  it('branch at index 2 has angle 45° at rotation 0', () => {
    const [, , branch] = getEndpoints(makePiece('junction'));
    expect(must(branch).outgoingAngleDeg).toBe(45);
  });

  it('all angles shift by 90° when rotated 90°', () => {
    const eps = getEndpoints(makePiece('junction', 90));
    expect(must(eps[0]).outgoingAngleDeg).toBe(270);
    expect(must(eps[1]).outgoingAngleDeg).toBe(90);
    expect(must(eps[2]).outgoingAngleDeg).toBe(135);
  });
});

describe('getEndpoints — station', () => {
  it('returns 2 endpoints', () => {
    expect(getEndpoints(makePiece('station'))).toHaveLength(2);
  });

  it('span is 220 mm at rotation 0', () => {
    const [entry, exit] = getEndpoints(makePiece('station'));
    expect(approx(must(entry).x, -110)).toBe(true);
    expect(approx(must(exit).x, 110)).toBe(true);
  });
});

describe('getEndpoints — terminus', () => {
  it('returns 1 endpoint (open end only)', () => {
    expect(getEndpoints(makePiece('terminus'))).toHaveLength(1);
  });

  it('open end is at (30, 0) facing east at rotation 0', () => {
    const [open] = getEndpoints(makePiece('terminus'));
    expect(approx(must(open).x, 30)).toBe(true);
    expect(approx(must(open).y, 0)).toBe(true);
    expect(must(open).outgoingAngleDeg).toBe(0);
  });

  it('rotates correctly at 180°', () => {
    const [open] = getEndpoints(makePiece('terminus', 180));
    expect(approx(must(open).x, -30)).toBe(true);
    expect(approx(must(open).y, 0)).toBe(true);
    expect(must(open).outgoingAngleDeg).toBe(180);
  });
});

describe('getEndpoints — crossing', () => {
  it('returns 4 endpoints', () => {
    expect(getEndpoints(makePiece('crossing'))).toHaveLength(4);
  });

  it('east endpoint is at (100, 0) with angle 0° at rotation 0', () => {
    const [east] = getEndpoints(makePiece('crossing'));
    expect(approx(must(east).x, 100)).toBe(true);
    expect(approx(must(east).y, 0)).toBe(true);
    expect(must(east).outgoingAngleDeg).toBe(0);
  });

  it('north endpoint is at (0, -100) with angle 270° at rotation 0', () => {
    const [, north] = getEndpoints(makePiece('crossing'));
    expect(approx(must(north).x, 0)).toBe(true);
    expect(approx(must(north).y, -100)).toBe(true);
    expect(must(north).outgoingAngleDeg).toBe(270);
  });

  it('rotates all four by 45°', () => {
    const eps = getEndpoints(makePiece('crossing', 45));
    expect(must(eps[0]).outgoingAngleDeg).toBe(45);
    expect(must(eps[1]).outgoingAngleDeg).toBe(315);
    expect(must(eps[2]).outgoingAngleDeg).toBe(225);
    expect(must(eps[3]).outgoingAngleDeg).toBe(135);
  });
});

describe('getEndpoints — carriage', () => {
  it('returns 0 endpoints (no track topology)', () => {
    expect(getEndpoints(makePiece('carriage'))).toHaveLength(0);
  });
});

describe('getPieceShape — carriage', () => {
  it('returns a non-empty svgPath', () => {
    const shape = getPieceShape(makePiece('carriage'));
    expect(shape.svgPath.length).toBeGreaterThan(0);
  });

  it('is smaller than the train (60mm vs 80mm wide)', () => {
    const carriageShape = getPieceShape(makePiece('carriage'));
    const trainShape = getPieceShape(makePiece('train'));
    expect(carriageShape.width).toBe(60);
    expect(carriageShape.width).toBeLessThan(trainShape.width);
  });

  it('has the same height as the train (24mm — fits on the rail band)', () => {
    const carriageShape = getPieceShape(makePiece('carriage'));
    const trainShape = getPieceShape(makePiece('train'));
    expect(carriageShape.height).toBe(trainShape.height);
  });
});

describe('isDevicePiece and isWireDevice — carriage', () => {
  it('isDevicePiece returns true for carriage', () => {
    expect(isDevicePiece('carriage')).toBe(true);
  });

  it('isWireDevice returns false for carriage', () => {
    expect(isWireDevice('carriage')).toBe(false);
  });

  it('isWireDevice returns true for train', () => {
    expect(isWireDevice('train')).toBe(true);
  });

  it('isWireDevice returns true for gate', () => {
    expect(isWireDevice('gate')).toBe(true);
  });

  it('pieceMarkerKind returns block_boundary for carriage (defensive/total)', () => {
    expect(pieceMarkerKind('carriage')).toBe('block_boundary');
  });
});

describe('getPieceShape', () => {
  const PIECE_TYPES: TrackPiece['type'][] = [
    'straight',
    'curve',
    'junction',
    'station',
    'terminus',
    'crossing',
  ];

  for (const type of PIECE_TYPES) {
    it(`returns a non-empty svgPath for ${type}`, () => {
      const shape = getPieceShape(makePiece(type));
      expect(shape.svgPath.length).toBeGreaterThan(0);
      expect(shape.width).toBeGreaterThan(0);
      expect(shape.height).toBeGreaterThan(0);
    });
  }

  it('straight shape has width 200', () => {
    expect(getPieceShape(makePiece('straight')).width).toBe(200);
  });

  it('station shape has width 220', () => {
    expect(getPieceShape(makePiece('station')).width).toBe(220);
  });

  it('terminus shape has width 60', () => {
    expect(getPieceShape(makePiece('terminus')).width).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// getCentreLinePath — rail geometry from the piece centre (marker) to an end.
// ---------------------------------------------------------------------------

const CURVE_HALF_LEN = 200 * (Math.PI / 8); // R · 22.5° in rad ≈ 78.54mm

/** Normalised absolute angular difference in degrees, in [0, 180]. */
function angleDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

describe('getCentreLinePath — half lengths', () => {
  it('straight half-length is 100mm (200mm piece, centre to end)', () => {
    const path = must(getCentreLinePath(makePiece('straight'), 0));
    expect(path.length).toBeCloseTo(100, 3);
  });

  it('station half-length is 110mm', () => {
    const path = must(getCentreLinePath(makePiece('station'), 0));
    expect(path.length).toBeCloseTo(110, 3);
  });

  it('junction trunk/through halves are 100mm, branch half is 100mm', () => {
    const j = makePiece('junction');
    expect(must(getCentreLinePath(j, 0)).length).toBeCloseTo(100, 3);
    expect(must(getCentreLinePath(j, 1)).length).toBeCloseTo(100, 3);
    expect(must(getCentreLinePath(j, 2)).length).toBeCloseTo(100, 3);
  });

  it('terminus half-length is 30mm', () => {
    expect(must(getCentreLinePath(makePiece('terminus'), 0)).length).toBeCloseTo(30, 3);
  });

  it('curve half-length is the ARC length R·(π/8) ≈ 78.54mm (not the chord)', () => {
    const path = must(getCentreLinePath(makePiece('curve'), 0));
    expect(path.length).toBeCloseTo(CURVE_HALF_LEN, 2);
    expect(path.length).toBeGreaterThan(CURVE_HALF_LEN - 0.01);
  });

  it('returns undefined for a device piece (no endpoints)', () => {
    expect(getCentreLinePath(makePiece('train'), 0)).toBeUndefined();
    expect(getCentreLinePath(makePiece('curve'), 5)).toBeUndefined();
  });
});

describe('getCentreLinePath — sampling reproduces getEndpoints at the far end', () => {
  it('straight: sampling at length matches endpoint position and outgoing angle', () => {
    const piece = makePiece('straight', 90);
    const eps = getEndpoints(piece);
    for (const i of [0, 1]) {
      const path = must(getCentreLinePath(piece, i));
      const end = path.at(path.length);
      expect(approx(end.x, must(eps[i]).x)).toBe(true);
      expect(approx(end.y, must(eps[i]).y)).toBe(true);
      expect(angleDelta(end.headingDeg, must(eps[i]).outgoingAngleDeg)).toBeLessThan(0.5);
    }
  });

  it('curve: sampling at length matches endpoint position and arc-tangent angle', () => {
    const piece = makePiece('curve');
    const eps = getEndpoints(piece);
    for (const i of [0, 1]) {
      const path = must(getCentreLinePath(piece, i));
      const end = path.at(path.length);
      expect(approx(end.x, must(eps[i]).x)).toBe(true);
      expect(approx(end.y, must(eps[i]).y)).toBe(true);
      expect(angleDelta(end.headingDeg, must(eps[i]).outgoingAngleDeg)).toBeLessThan(0.5);
    }
    // At the centre (d=0) the curve sits at the origin (the marker).
    const start = must(getCentreLinePath(piece, 0)).at(0);
    expect(approx(start.x, 0)).toBe(true);
    expect(approx(start.y, 0)).toBe(true);
  });

  it('junction: each leg reproduces its endpoint position and angle', () => {
    const piece = makePiece('junction', 45);
    const eps = getEndpoints(piece);
    for (const i of [0, 1, 2]) {
      const path = must(getCentreLinePath(piece, i));
      const end = path.at(path.length);
      expect(approx(end.x, must(eps[i]).x)).toBe(true);
      expect(approx(end.y, must(eps[i]).y)).toBe(true);
      expect(angleDelta(end.headingDeg, must(eps[i]).outgoingAngleDeg)).toBeLessThan(0.5);
    }
  });
});

describe('getCentreLinePath — flip and rotation', () => {
  it('a FLIPPED curve mirrors position AND heading across the x-axis', () => {
    const normalPath = must(getCentreLinePath(makePiece('curve'), 1));
    const flippedPath = must(getCentreLinePath({ ...makePiece('curve'), flipped: true }, 1));
    const dMid = normalPath.length / 2;
    const n = normalPath.at(dMid);
    const f = flippedPath.at(dMid);
    // x preserved, y mirrored.
    expect(approx(f.x, n.x)).toBe(true);
    expect(approx(f.y, -n.y)).toBe(true);
    // Heading reflected across the x-axis (negated).
    expect(angleDelta(f.headingDeg, -n.headingDeg)).toBeLessThan(0.5);
  });

  it('a ROTATED (90°) curve rotates position AND heading by 90°', () => {
    const base = must(getCentreLinePath(makePiece('curve'), 1));
    const rot = must(getCentreLinePath(makePiece('curve', 90), 1));
    const dMid = base.length / 2;
    const b = base.at(dMid);
    const r = rot.at(dMid);
    // Rotating (x,y) by +90° clockwise (SVG): (x,y) → (-y, x) about origin.
    expect(approx(r.x, -b.y)).toBe(true);
    expect(approx(r.y, b.x)).toBe(true);
    expect(angleDelta(r.headingDeg, b.headingDeg + 90)).toBeLessThan(0.5);
  });
});
