import { describe, expect, it } from 'vitest';
import { solveFollow } from './flex-solver.js';
import { selectAnchor } from './flex-solver.js';
import { type FlexState, applyFlex } from './flex.js';
import { connectedComponents } from './loops.js';
import { type TrackPiece, type TrackPieceType, getEndpoints } from './pieces.js';
import { computePlacement } from './placement.js';

/**
 * BROADER reproduction sweep (goal A, criteria 1 & 3): the place→flex→add path
 * over BRANCHING topologies — junctions (3 ends) and crossings (4 ends) — and
 * flexing RANDOM pieces (not just the free end). This drives the EXACT live flex
 * flow the toy table uses (solveFollow → selectAnchor → applyFlex → bake), which
 * the open-arc sweep never exercised: a junction makes applyFlex's forward
 * kinematics a TREE walk, not a line, and a piece far down a branch is the most
 * likely thing to be lost. Asserts no piece ever vanishes (count preserved, every
 * pose finite + on-canvas, connectivity never silently collapses).
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

interface OpenEnd {
  readonly piece: TrackPiece;
  readonly x: number;
  readonly y: number;
}

/* Endpoints with no other piece's endpoint nearby — where a new piece can snap
   on. Geometric (decoupled from the joint graph): open ⇒ nothing within 20mm. */
function openEnds(pieces: ReadonlyArray<TrackPiece>): OpenEnd[] {
  const all = pieces.flatMap((p) => getEndpoints(p).map((e) => ({ piece: p, x: e.x, y: e.y })));
  return all.filter(
    (e) => !all.some((o) => o.piece.id !== e.piece.id && Math.hypot(o.x - e.x, o.y - e.y) < 20),
  );
}

function assertNoVanish(pieces: ReadonlyArray<TrackPiece>, where: string): void {
  for (const p of pieces) {
    const finite =
      Number.isFinite(p.position.x) &&
      Number.isFinite(p.position.y) &&
      Number.isFinite(p.rotationDeg);
    expect(
      finite,
      `${where}: ${p.id} (${p.type}) finite (${p.position.x},${p.position.y},${p.rotationDeg})`,
    ).toBe(true);
    expect(Math.abs(p.position.x) < 5000, `${where}: ${p.id} x bounded (${p.position.x})`).toBe(
      true,
    );
    expect(Math.abs(p.position.y) < 5000, `${where}: ${p.id} y bounded (${p.position.y})`).toBe(
      true,
    );
  }
}

const TYPE_POOL: TrackPieceType[] = ['straight', 'curve', 'curve-tight', 'junction', 'crossing'];

/* Flex a piece exactly as ToyTable does: a warm-started multi-frame drag toward a
   random walk of targets (solveFollow + selectAnchor + applyFlex per frame, every
   frame asserted finite), then BAKE the final flex into the poses. */
function flexBake(
  pieces: ReadonlyArray<TrackPiece>,
  draggedId: string,
  rand: () => number,
  where: string,
): TrackPiece[] {
  let seedFlex: FlexState | undefined;
  let flex: FlexState = new Map();
  let anchorId = selectAnchor(pieces, draggedId);
  for (let frame = 0; frame < 16; frame++) {
    flex = solveFollow(pieces, draggedId, { x: 80 + rand() * 640, y: 60 + rand() * 460 }, seedFlex);
    seedFlex = flex;
    anchorId = selectAnchor(pieces, draggedId);
    assertNoVanish([...applyFlex(pieces, flex, anchorId)], `${where} live`);
  }
  const baked = [...applyFlex(pieces, flex, anchorId)];
  assertNoVanish(baked, `${where} baked`);
  return baked;
}

describe('branching flex → add: no piece vanishes (criteria 1/3)', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 42, 99, 256, 777, 1009, 4242, 31337]) {
    it(`seed ${seed}: junctions/crossings, random-piece flex, never vanishes`, () => {
      const rand = rng(seed);
      const pick = <T>(arr: ReadonlyArray<T>): T => arr[Math.floor(rand() * arr.length)] as T;

      // Seed a small branching structure.
      const first = computePlacement(400, 250, 'junction', []);
      let pieces: TrackPiece[] = [
        {
          id: 'p0',
          type: 'junction',
          position: { x: first.x, y: first.y },
          rotationDeg: first.rotationDeg,
          tagged: false,
        },
      ];
      let n = 1;

      // Grow: snap pieces onto random OPEN endpoints (a junction/crossing's spare
      // ends become branches → a real tree).
      for (let i = 0; i < 7; i++) {
        const ends = openEnds(pieces);
        if (ends.length === 0) break;
        const target = pick(ends);
        const type = pick(TYPE_POOL);
        const placement = computePlacement(target.x, target.y, type, pieces);
        pieces.push({
          id: `p${n}`,
          type,
          position: { x: placement.x, y: placement.y },
          rotationDeg: placement.rotationDeg,
          tagged: false,
        });
        n += 1;
        assertNoVanish(pieces, `after grow ${i}`);
      }

      const baseCount = pieces.length;
      const baseComponents = connectedComponents(pieces).length;

      // Flex random pieces (often deep in a branch, not the free end) then ADD.
      for (let round = 0; round < 4; round++) {
        const draggedId = pick(pieces).id;
        pieces = flexBake(pieces, draggedId, rand, `round ${round} flex ${draggedId}`);
        expect(pieces.length, `round ${round}: count after flex`).toBe(baseCount + round);

        const ends = openEnds(pieces);
        if (ends.length > 0) {
          const target = pick(ends);
          const type = pick(TYPE_POOL);
          const placement = computePlacement(target.x, target.y, type, pieces);
          expect(
            Number.isFinite(placement.x) &&
              Number.isFinite(placement.y) &&
              Number.isFinite(placement.rotationDeg),
            `round ${round}: placement finite`,
          ).toBe(true);
          pieces.push({
            id: `add${round}`,
            type,
            position: { x: placement.x, y: placement.y },
            rotationDeg: placement.rotationDeg,
            tagged: false,
          });
        }
        assertNoVanish(pieces, `round ${round} after add`);
      }

      // Connectivity never silently fragments beyond what adds can justify.
      expect(connectedComponents(pieces).length).toBeLessThanOrEqual(baseComponents + 4);
    });
  }
});
