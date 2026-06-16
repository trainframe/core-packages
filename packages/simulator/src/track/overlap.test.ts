import { describe, expect, it } from 'vitest';
import { detectSameLayerCrossings, detectSameLayerOverlaps, pierSuppressed } from './overlap.js';
import type { RotationDeg, TrackPiece } from './pieces.js';

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

function rotStraight(
  id: string,
  x: number,
  y: number,
  rot: RotationDeg,
  layer?: number,
): TrackPiece {
  return {
    id,
    type: 'straight',
    position: { x, y },
    rotationDeg: rot,
    tagged: false,
    ...(layer !== undefined && layer !== 0 ? { layer } : {}),
  };
}

describe('detectSameLayerCrossings', () => {
  it('catches two rails that CROSS with their centres far apart (the gap the overlap test misses)', () => {
    /* A horizontal straight at the origin and a vertical one crossing it near the
     *  horizontal's END: their centres are 90mm apart — beyond the 60mm overlap
     *  band, so `detectSameLayerOverlaps` sees nothing — yet the rails genuinely
     *  cross (two trains would collide). */
    const h = straight('h', 0, 0); // (-100,0)..(100,0)
    const v = rotStraight('v', 90, 0, 90); // (90,-100)..(90,100), crosses h at (90,0)
    expect(detectSameLayerOverlaps([h, v]).size).toBe(0); // the old test is blind to it
    const crossed = detectSameLayerCrossings([h, v]);
    expect(crossed.has('h')).toBe(true);
    expect(crossed.has('v')).toBe(true);
  });

  it('does NOT flag a cross on a different layer (a bridge)', () => {
    const h = straight('h', 0, 0);
    const v = rotStraight('v', 90, 0, 90, 1); // layer 1 — a flyover
    expect(detectSameLayerCrossings([h, v]).size).toBe(0);
  });

  it('does NOT flag adjacent pieces that merely share a joint', () => {
    const a = straight('a', 0, 0); // ends at (100,0)
    const b = straight('b', 200, 0); // starts at (100,0) — joined, not crossing
    expect(detectSameLayerCrossings([a, b]).size).toBe(0);
  });
});

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

describe('pierSuppressed — supports avoid the rail below', () => {
  it('a raised piece over open table keeps its pier', () => {
    const deck = straight('deck', 500, 500, 1);
    expect(pierSuppressed(deck, [deck])).toBe(false);
  });

  it('a raised piece directly over ground track suppresses its pier', () => {
    // The deck spans over a ground rail sharing its footprint — the column
    // would plant on the rail beneath, so it is omitted.
    const ground = straight('ground', 500, 500, 0);
    const deck = straight('deck', 500, 500, 1);
    expect(pierSuppressed(deck, [ground, deck])).toBe(true);
  });

  it('only LOWER track blocks a pier — a piece on the same or higher layer does not', () => {
    const deck = straight('deck', 500, 500, 1);
    const sameLayer = straight('same', 500, 500, 1);
    const higher = straight('higher', 500, 500, 2);
    expect(pierSuppressed(deck, [deck, sameLayer, higher])).toBe(false);
  });

  it('ground track and device pieces never carry a pier', () => {
    const ground = straight('ground', 500, 500, 0);
    const train: TrackPiece = {
      id: 'train',
      type: 'train',
      position: { x: 500, y: 500 },
      rotationDeg: 0,
      tagged: false,
      layer: 2,
    };
    expect(pierSuppressed(ground, [ground])).toBe(false);
    expect(pierSuppressed(train, [train])).toBe(false);
  });

  it('a lower piece that is far away does not block the pier', () => {
    const ground = straight('ground', 100, 100, 0);
    const deck = straight('deck', 700, 700, 1);
    expect(pierSuppressed(deck, [ground, deck])).toBe(false);
  });

  it('a perpendicular deck crossing OVER a ground rail suppresses its pier', () => {
    // The real bridge case: a ground rail runs horizontally through (450,300),
    // its body spanning x∈[350,550]. The deck piece crosses it at right angles
    // with its CENTRE (the pier point) sitting on the ground rail at (500,300) —
    // 50mm along the ground rail from its centre. The pier point is squarely on
    // the rail below, so it must be suppressed even though the two CENTRES are
    // 50mm apart along the ground rail's length.
    const ground = straight('ground', 450, 300, 0);
    const deck: TrackPiece = {
      id: 'deck',
      type: 'straight',
      position: { x: 500, y: 300 },
      rotationDeg: 90,
      tagged: false,
      layer: 1,
    };
    expect(pierSuppressed(deck, [ground, deck])).toBe(true);
  });

  it('a deck pier just BESIDE a ground rail (not over it) keeps its pier', () => {
    // The ground rail spans x∈[350,550] at y=300. The deck piece sits at
    // (450,360) — 60mm clear of the rail body in y — so its pier lands beside
    // the span, not on the rail, and must survive.
    const ground = straight('ground', 450, 300, 0);
    const deck = straight('deck', 450, 360, 1);
    expect(pierSuppressed(deck, [ground, deck])).toBe(false);
  });
});
