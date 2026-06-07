import { describe, expect, it } from 'vitest';
import { detectSameLayerOverlaps } from './overlap.js';
import type { TrackPiece } from './pieces.js';

function straight(id: string, x: number, y: number, layer?: number): TrackPiece {
  return {
    id,
    type: 'straight',
    position: { x, y },
    rotationDeg: 0,
    tagged: false,
    ...(layer !== undefined && layer !== 0 ? { layer } : {}),
  };
}

describe('detectSameLayerOverlaps', () => {
  it('flags two same-layer parallel straights overlapping with no shared endpoint', () => {
    // Two horizontal 200mm straights offset 40mm in y: centres 40mm apart
    // (< OVERLAP_CENTRE_DISTANCE_MM, bodies overlap) while their endpoints are
    // 40mm apart (> OVERLAP_SHARED_ENDPOINT_MM, no shared join) — an invalid
    // track-on-track stack the operator should see flagged.
    const a = straight('a', 500, 500);
    const b = straight('b', 500, 540);
    const flagged = detectSameLayerOverlaps([a, b]);
    expect(flagged.has('a')).toBe(true);
    expect(flagged.has('b')).toBe(true);
  });

  it('flags perpendicular same-layer straights crossing at a point (no shared endpoint)', () => {
    const a = straight('a', 500, 500); // horizontal
    const b: TrackPiece = {
      id: 'b',
      type: 'straight',
      position: { x: 500, y: 500 },
      rotationDeg: 90, // vertical, same centre
      tagged: false,
    };
    const flagged = detectSameLayerOverlaps([a, b]);
    expect(flagged.has('a')).toBe(true);
    expect(flagged.has('b')).toBe(true);
  });

  it('does NOT flag a legitimate bridge crossing on different layers', () => {
    const ground = straight('ground', 500, 500, 0);
    const deck: TrackPiece = {
      id: 'deck',
      type: 'straight',
      position: { x: 500, y: 500 },
      rotationDeg: 90,
      tagged: false,
      layer: 1,
    };
    const flagged = detectSameLayerOverlaps([ground, deck]);
    expect(flagged.size).toBe(0);
  });

  it('does NOT flag two normally-connected straights end-to-end', () => {
    const a = straight('a', 500, 500);
    const b = straight('b', 700, 500); // 200mm east — shares the endpoint at (600,500)
    const flagged = detectSameLayerOverlaps([a, b]);
    expect(flagged.size).toBe(0);
  });

  it('does NOT flag pieces that are simply far apart', () => {
    const a = straight('a', 100, 100);
    const b = straight('b', 900, 900);
    expect(detectSameLayerOverlaps([a, b]).size).toBe(0);
  });

  it('ignores device pieces sitting on track (a train on a straight is fine)', () => {
    const rail = straight('rail', 500, 500);
    const train: TrackPiece = {
      id: 'train',
      type: 'train',
      position: { x: 500, y: 500 },
      rotationDeg: 0,
      tagged: false,
    };
    expect(detectSameLayerOverlaps([rail, train]).size).toBe(0);
  });
});
