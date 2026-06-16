import { describe, expect, it } from 'vitest';
import {
  CARRIAGE_SPACING_MM,
  COUPLING_DISTANCE_MM,
  carriageWorldPos,
  computeTrainTrails,
} from './coupling.js';
import type { TrackPiece } from './pieces.js';

function makePiece(id: string, type: TrackPiece['type'], x: number, y: number): TrackPiece {
  return { id, type, position: { x, y }, rotationDeg: 0, tagged: false };
}

function makeLiveIds(...ids: string[]): ReadonlySet<string> {
  return new Set(ids);
}

describe('computeTrainTrails — basic coupling', () => {
  it('returns empty map when there are no carriages', () => {
    const pieces = [makePiece('T1', 'train', 0, 0)];
    const result = computeTrainTrails(pieces, makeLiveIds('T1'));
    expect(result.size).toBe(0);
  });

  it('returns empty map when there are no live trains', () => {
    const pieces = [makePiece('T1', 'train', 0, 0), makePiece('C1', 'carriage', 50, 0)];
    // T1 is NOT live
    const result = computeTrainTrails(pieces, makeLiveIds());
    expect(result.size).toBe(0);
  });

  it('couples a carriage within COUPLING_DISTANCE_MM of a live train', () => {
    const d = COUPLING_DISTANCE_MM - 10; // just inside threshold
    const pieces = [makePiece('T1', 'train', 0, 0), makePiece('C1', 'carriage', d, 0)];
    const result = computeTrainTrails(pieces, makeLiveIds('T1'));
    expect(result.get('T1')).toEqual(['C1']);
  });

  it('does not couple a carriage beyond COUPLING_DISTANCE_MM of a live train', () => {
    const d = COUPLING_DISTANCE_MM + 10; // just outside threshold
    const pieces = [makePiece('T1', 'train', 0, 0), makePiece('C1', 'carriage', d, 0)];
    const result = computeTrainTrails(pieces, makeLiveIds('T1'));
    expect(result.size).toBe(0);
  });

  it('couples a carriage exactly at COUPLING_DISTANCE_MM', () => {
    const pieces = [
      makePiece('T1', 'train', 0, 0),
      makePiece('C1', 'carriage', COUPLING_DISTANCE_MM, 0),
    ];
    const result = computeTrainTrails(pieces, makeLiveIds('T1'));
    expect(result.get('T1')).toEqual(['C1']);
  });

  it('does not couple a dead train (not in liveIds)', () => {
    const d = COUPLING_DISTANCE_MM - 10;
    const pieces = [makePiece('T1', 'train', 0, 0), makePiece('C1', 'carriage', d, 0)];
    // T1 not live
    const result = computeTrainTrails(pieces, makeLiveIds());
    expect(result.size).toBe(0);
  });
});

describe('computeTrainTrails — chained coupling', () => {
  it('chains a carriage via another coupled carriage (flood-fill)', () => {
    // T1 at 0,0 — C1 at 80mm — C2 at 160mm.
    // C1 is within COUPLING_DISTANCE_MM(100) of T1; C2 is within 100 of C1.
    // Both should be pulled into T1's trail.
    const d = 80;
    const pieces = [
      makePiece('T1', 'train', 0, 0),
      makePiece('C1', 'carriage', d, 0),
      makePiece('C2', 'carriage', d * 2, 0),
    ];
    const result = computeTrainTrails(pieces, makeLiveIds('T1'));
    const trail = result.get('T1') ?? [];
    expect(trail).toContain('C1');
    expect(trail).toContain('C2');
    expect(trail.length).toBe(2);
  });

  it('does not chain a carriage that is only reachable via an uncoupled gap', () => {
    // T1 at 0 — C1 at 80mm — [gap: 200mm] — C2 at 280mm.
    // C1 couples to T1 (80 < 100). C2 is 200mm from C1, > 100mm, so not reached.
    const pieces = [
      makePiece('T1', 'train', 0, 0),
      makePiece('C1', 'carriage', 80, 0),
      makePiece('C2', 'carriage', 280, 0),
    ];
    const result = computeTrainTrails(pieces, makeLiveIds('T1'));
    const trail = result.get('T1') ?? [];
    expect(trail).toContain('C1');
    expect(trail).not.toContain('C2');
  });
});

describe('computeTrainTrails — multiple trains and tie-breaking', () => {
  it('does not let two trains claim the same carriage', () => {
    // T1 at -60, T2 at +60, C1 at 0 — equidistant from both.
    // T1 appears first in the array, so it claims C1.
    const pieces = [
      makePiece('T1', 'train', -60, 0),
      makePiece('T2', 'train', 60, 0),
      makePiece('C1', 'carriage', 0, 0),
    ];
    const result = computeTrainTrails(pieces, makeLiveIds('T1', 'T2'));
    // Exactly one train should have C1.
    const t1Trail = result.get('T1') ?? [];
    const t2Trail = result.get('T2') ?? [];
    const claimCount = (t1Trail.includes('C1') ? 1 : 0) + (t2Trail.includes('C1') ? 1 : 0);
    expect(claimCount).toBe(1);
  });

  it('first-in-array train wins the tie (T1 before T2)', () => {
    const pieces = [
      makePiece('T1', 'train', -60, 0),
      makePiece('T2', 'train', 60, 0),
      makePiece('C1', 'carriage', 0, 0),
    ];
    const result = computeTrainTrails(pieces, makeLiveIds('T1', 'T2'));
    expect(result.get('T1')).toContain('C1');
    expect(result.get('T2')).toBeUndefined();
  });

  it('second train claims its own nearby carriage', () => {
    const d = 60;
    const pieces = [
      makePiece('T1', 'train', 0, 0),
      makePiece('C1', 'carriage', d, 0),
      makePiece('T2', 'train', 500, 0),
      makePiece('C2', 'carriage', 500 + d, 0),
    ];
    const result = computeTrainTrails(pieces, makeLiveIds('T1', 'T2'));
    expect(result.get('T1')).toEqual(['C1']);
    expect(result.get('T2')).toEqual(['C2']);
  });

  it('returns only trains that have at least one coupled carriage', () => {
    const pieces = [
      makePiece('T1', 'train', 0, 0),
      makePiece('T2', 'train', 500, 0),
      makePiece('C1', 'carriage', 50, 0), // near T1
    ];
    const result = computeTrainTrails(pieces, makeLiveIds('T1', 'T2'));
    expect(result.has('T1')).toBe(true);
    expect(result.has('T2')).toBe(false);
  });
});

describe('computeTrainTrails — non-carriage pieces ignored', () => {
  it('ignores track pieces (straight, station etc.) in proximity calculation', () => {
    const d = 50;
    const pieces = [
      makePiece('T1', 'train', 0, 0),
      makePiece('S1', 'straight', d, 0), // not a carriage
      makePiece('C1', 'carriage', d * 3, 0), // too far
    ];
    const result = computeTrainTrails(pieces, makeLiveIds('T1'));
    expect(result.size).toBe(0);
  });

  it('ignores gate pieces', () => {
    const pieces = [makePiece('T1', 'train', 0, 0), makePiece('G1', 'gate', 50, 0)];
    const result = computeTrainTrails(pieces, makeLiveIds('T1'));
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// carriageWorldPos — pure physics positioning
// ---------------------------------------------------------------------------

describe('carriageWorldPos — position along a horizontal edge', () => {
  // Edge M-A at (0,0) → M-B at (200,0). Length = 200mm.
  const FROM = { x: 0, y: 0 };
  const TO = { x: 200, y: 0 };
  const LENGTH = 200;

  it('places a train at d=100 at world (100, 0) with 0° rotation', () => {
    const pos = carriageWorldPos(FROM, TO, LENGTH, 100);
    expect(pos.x).toBeCloseTo(100);
    expect(pos.y).toBeCloseTo(0);
    expect(pos.rotationDeg).toBeCloseTo(0);
  });

  it('places the first coupled carriage (trail index 0) one spacing behind the head', () => {
    // d_carriage = 100 - (0 + 1) * CARRIAGE_SPACING_MM, along the +x edge.
    const carriageDist = 100 - 1 * CARRIAGE_SPACING_MM;
    const pos = carriageWorldPos(FROM, TO, LENGTH, carriageDist);
    expect(pos.x).toBeCloseTo(100 - CARRIAGE_SPACING_MM);
    expect(pos.y).toBeCloseTo(0);
    expect(pos.rotationDeg).toBeCloseTo(0);
  });

  it('places train at edge start (d=0) at world (0, 0)', () => {
    const pos = carriageWorldPos(FROM, TO, LENGTH, 0);
    expect(pos.x).toBeCloseTo(0);
    expect(pos.y).toBeCloseTo(0);
  });

  it('places train at edge end (d=L) at world (200, 0)', () => {
    const pos = carriageWorldPos(FROM, TO, LENGTH, 200);
    expect(pos.x).toBeCloseTo(200);
    expect(pos.y).toBeCloseTo(0);
  });
});

describe('carriageWorldPos — position along a vertical edge', () => {
  // Edge from (0,0) pointing south to (0, 200).
  const FROM = { x: 0, y: 0 };
  const TO = { x: 0, y: 200 };
  const LENGTH = 200;

  it('rotation is 90° for a south-pointing edge', () => {
    const pos = carriageWorldPos(FROM, TO, LENGTH, 100);
    expect(pos.x).toBeCloseTo(0);
    expect(pos.y).toBeCloseTo(100);
    expect(pos.rotationDeg).toBeCloseTo(90);
  });
});

describe('carriageWorldPos — diagonal edge', () => {
  // Edge from (0,0) to (100,100). Length = sqrt(20000).
  const FROM = { x: 0, y: 0 };
  const TO = { x: 100, y: 100 };
  const LENGTH = Math.sqrt(100 * 100 + 100 * 100);

  it('rotation is 45° for a northeast-pointing edge', () => {
    const pos = carriageWorldPos(FROM, TO, LENGTH, LENGTH / 2);
    expect(pos.x).toBeCloseTo(50);
    expect(pos.y).toBeCloseTo(50);
    expect(pos.rotationDeg).toBeCloseTo(45);
  });
});

describe('carriageWorldPos — zero-length edge guard', () => {
  it('does not divide by zero when edgeLengthMm = 0', () => {
    const FROM = { x: 10, y: 20 };
    const TO = { x: 10, y: 20 };
    const pos = carriageWorldPos(FROM, TO, 0, 50);
    // t = 0 when edgeLengthMm = 0; piece stays at FROM.
    expect(pos.x).toBeCloseTo(10);
    expect(pos.y).toBeCloseTo(20);
  });
});
