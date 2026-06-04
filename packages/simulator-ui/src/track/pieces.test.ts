import { describe, expect, it } from 'vitest';
import {
  type RotationDeg,
  type TrackPiece,
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
