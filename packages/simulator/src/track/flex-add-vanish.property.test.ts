import { describe, expect, it } from 'vitest';
import { solveFollow } from './flex-solver.js';
import { type FlexState, applyFlex } from './flex.js';
import { connectedComponents } from './loops.js';
import { type TrackPiece, type TrackPieceType, getEndpoints } from './pieces.js';
import { computePlacement } from './placement.js';

/**
 * Reproduction sweep (goal A, criteria 1 & 3): the place → flex → ADD sequence
 * the existing flex-invariant property test never exercises. Build a chain, flex
 * + BAKE its open end (drifting the rest frame off-grid as the toy table does),
 * then snap a NEW piece onto that baked end via the real placement path — exactly
 * like ToyTable.handleDrop. Assert NOTHING goes non-finite or flies off-canvas:
 * not the anchor, not a piece far down the line, not the newly-added piece.
 *
 * Brute-forces the geometry deterministically (seeded, no Math.random) across
 * chain lengths, piece types, flips, and flex directions to catch the "sometimes".
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Build a connected chain of `types[i]` pieces, each snapped onto the previous
   piece's exit endpoint via the real placement path. One open arc. */
function chain(types: ReadonlyArray<TrackPieceType>, flips: ReadonlyArray<boolean>): TrackPiece[] {
  const pieces: TrackPiece[] = [];
  const first = computePlacement(450, 300, types[0] ?? 'curve', pieces, flips[0] ?? false);
  pieces.push({
    id: 'p0',
    type: types[0] ?? 'curve',
    position: { x: first.x, y: first.y },
    rotationDeg: first.rotationDeg,
    tagged: false,
    ...(flips[0] ? { flipped: true } : {}),
  });
  for (let i = 1; i < types.length; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const type = types[i] ?? 'curve';
    const flipped = flips[i] ?? false;
    const p = computePlacement(exit.x, exit.y, type, pieces, flipped);
    pieces.push({
      id: `p${i}`,
      type,
      position: { x: p.x, y: p.y },
      rotationDeg: p.rotationDeg,
      tagged: false,
      ...(flipped ? { flipped: true } : {}),
    });
  }
  return pieces;
}

/** Every piece's pose must be finite and within a generous on-canvas envelope. */
function assertAllFinite(pieces: ReadonlyArray<TrackPiece>, where: string): void {
  for (const p of pieces) {
    const ok =
      Number.isFinite(p.position.x) &&
      Number.isFinite(p.position.y) &&
      Number.isFinite(p.rotationDeg);
    expect(ok, `${where}: ${p.id} finite (${p.position.x},${p.position.y},${p.rotationDeg})`).toBe(
      true,
    );
    expect(Math.abs(p.position.x) < 5000, `${where}: ${p.id} x bounded (${p.position.x})`).toBe(
      true,
    );
    expect(Math.abs(p.position.y) < 5000, `${where}: ${p.id} y bounded (${p.position.y})`).toBe(
      true,
    );
  }
}

const TYPE_POOL: TrackPieceType[] = ['straight', 'curve', 'curve-tight'];

/* Warm-started multi-frame drag of the open end toward a random walk of targets
   (each frame seeded off the previous, so the chain rubber-bands as a real drag
   does), then BAKE on release. Asserts every live frame stays finite. */
function flexBakeEnd(
  pieces: ReadonlyArray<TrackPiece>,
  rand: () => number,
  round: number,
): TrackPiece[] {
  const endId = pieces[pieces.length - 1]?.id;
  if (endId === undefined) throw new Error('unreachable');
  let seedFlex: FlexState | undefined;
  let flex: FlexState = new Map();
  for (let frame = 0; frame < 24; frame++) {
    flex = solveFollow(pieces, endId, { x: 80 + rand() * 640, y: 60 + rand() * 520 }, seedFlex);
    seedFlex = flex;
    assertAllFinite([...applyFlex(pieces, flex)], `round ${round} frame ${frame} live`);
  }
  const baked = [...applyFlex(pieces, flex)];
  assertAllFinite(baked, `round ${round} after bake`);
  return baked;
}

/* Snap a new piece onto the (baked, off-grid) open end via the real placement
   path — ToyTable.handleDrop. Returns the chain with the piece appended. */
function snapAddOntoEnd(pieces: TrackPiece[], rand: () => number, round: number): TrackPiece[] {
  const openEnd = getEndpoints(pieces[pieces.length - 1] as TrackPiece)[1];
  if (openEnd === undefined) throw new Error('unreachable');
  const addType = TYPE_POOL[Math.floor(rand() * 3)] ?? 'curve';
  const placement = computePlacement(openEnd.x, openEnd.y, addType, pieces);
  expect(
    Number.isFinite(placement.x) &&
      Number.isFinite(placement.y) &&
      Number.isFinite(placement.rotationDeg),
    `round ${round}: placement finite (${placement.x},${placement.y},${placement.rotationDeg})`,
  ).toBe(true);
  pieces.push({
    id: `add${round}`,
    type: addType,
    position: { x: placement.x, y: placement.y },
    rotationDeg: placement.rotationDeg,
    tagged: false,
  });
  assertAllFinite(pieces, `round ${round} after add`);
  return pieces;
}

describe('place → flex+bake → add: no piece vanishes (criterion 1/3)', () => {
  for (const seed of [1, 2, 3, 7, 11, 42, 101, 777, 1234, 5555, 99999]) {
    it(`seed ${seed}: every pose stays finite + on-canvas through flex/bake/add cycles`, () => {
      const rand = rng(seed);
      const n = 3 + Math.floor(rand() * 5); // 3..7 pieces
      const types = Array.from({ length: n }, () => TYPE_POOL[Math.floor(rand() * 3)] ?? 'curve');
      const flips = Array.from({ length: n }, () => rand() < 0.4);
      let pieces = chain(types, flips);
      assertAllFinite(pieces, 'after build');
      const baseComponents = connectedComponents(pieces).length;

      /* Three rounds of the exact place→flex→add the bug report describes,
         repeated so off-grid drift can compound. */
      for (let round = 0; round < 3; round++) {
        pieces = snapAddOntoEnd(flexBakeEnd(pieces, rand, round), rand, round);
      }

      // The added pieces must have actually joined (no silent sever explosion).
      expect(connectedComponents(pieces).length).toBeLessThanOrEqual(baseComponents);
    });
  }
});
