import { describe, expect, it } from 'vitest';
import { selectAnchor, solveFollow } from './flex-solver.js';
import { type FlexState, applyFlex } from './flex.js';
import { type TrackPiece, type TrackPieceType, getEndpoints } from './pieces.js';
import { computePlacement } from './placement.js';

/**
 * Guards the one gap the open-arc and branching sweeps left (goal A, criteria
 * 1–3): defect D6 — "cross-gesture anchor re-root may shift a JUNCTION-LESS open
 * chain" (`docs/superpowers/defects/2026-06-21-track-flex-defects.md`, logged
 * unconfirmed). A junction-less chain has NO stable anchor: `selectAnchor` picks
 * the far point, which FLIPS depending on which end you drag — so flexing first
 * one end then the other re-roots `applyFlex`'s forward kinematics on each
 * gesture. THIS is the exact shape of the reported "the presumed anchor piece
 * vanishes" (the prior tests all flexed a consistent end, or used a junction =
 * stable anchor, so they couldn't surface it).
 *
 * Measured (this guard): the re-root keeps the chain SOUND across many alternating
 * gestures + adds — the gesture's anchor stays exactly fixed, every pose stays
 * finite, and no piece is ever flung beyond the chain's own geometric reach
 * (= it cannot teleport / go to NaN). The dramatic vanish the report describes
 * does not occur in the current (post bake-on-release / authoritative-connection)
 * code; if it is ever reintroduced this fails loudly.
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

/* A junction-less open chain — the topology with no stable FK anchor. */
function openChain(n: number, type: TrackPieceType): TrackPiece[] {
  const ps: TrackPiece[] = [];
  const f = computePlacement(450, 300, type, ps);
  ps.push({
    id: 'p0',
    type,
    position: { x: f.x, y: f.y },
    rotationDeg: f.rotationDeg,
    tagged: false,
  });
  for (let i = 1; i < n; i++) {
    const e = getEndpoints(ps[i - 1] as TrackPiece)[1];
    if (e === undefined) throw new Error('unreachable');
    const p = computePlacement(e.x, e.y, type, ps);
    ps.push({
      id: `p${i}`,
      type,
      position: { x: p.x, y: p.y },
      rotationDeg: p.rotationDeg,
      tagged: false,
    });
  }
  return ps;
}

/* The maximum straight-line distance a piece can sit from the anchor: the sum of
   per-piece extents along the chain, plus a margin. A pose beyond this is a
   teleport/fling — geometrically impossible for a connected chain. */
function reachFromAnchor(pieces: ReadonlyArray<TrackPiece>): number {
  let reach = 0;
  for (const p of pieces) {
    const eps = getEndpoints(p);
    let span = 0;
    for (const a of eps)
      for (const b of eps) span = Math.max(span, Math.hypot(a.x - b.x, a.y - b.y));
    reach += span + 10;
  }
  return reach + 50;
}

/* Assert one re-root gesture is sound: anchor pinned, every pose finite + within
   the chain's geometric reach (no teleport / NaN), no piece lost. */
function assertGestureSound(
  before: ReadonlyArray<TrackPiece>,
  baked: ReadonlyArray<TrackPiece>,
  anchorId: string,
  g: number,
): void {
  const anchorBefore = before.find((p) => p.id === anchorId);
  const anchorAfter = baked.find((p) => p.id === anchorId);
  if (anchorBefore === undefined || anchorAfter === undefined) {
    throw new Error(`anchor ${anchorId} missing (g${g})`);
  }
  const anchorMoved = Math.hypot(
    anchorAfter.position.x - anchorBefore.position.x,
    anchorAfter.position.y - anchorBefore.position.y,
  );
  expect(anchorMoved, `g${g}: anchor ${anchorId} stayed pinned`).toBeLessThan(0.5);

  const reach = reachFromAnchor(baked);
  for (const p of baked) {
    const finite =
      Number.isFinite(p.position.x) &&
      Number.isFinite(p.position.y) &&
      Number.isFinite(p.rotationDeg);
    expect(finite, `g${g}: ${p.id} finite`).toBe(true);
    const fromAnchor = Math.hypot(
      p.position.x - anchorAfter.position.x,
      p.position.y - anchorAfter.position.y,
    );
    expect(fromAnchor, `g${g}: ${p.id} within reach`).toBeLessThanOrEqual(reach);
  }
  expect(baked.length, `g${g}: piece count`).toBe(before.length);
}

describe('junction-less cross-gesture re-root never vanishes a piece (D6, criteria 1–3)', () => {
  for (const type of ['curve', 'straight', 'curve-tight'] as const) {
    for (const seed of [1, 7, 23, 99, 512]) {
      it(`${type} seed ${seed}: alternating-end flex (anchor flips) keeps the chain sound`, () => {
        const rand = rng(seed);
        let pieces = openChain(6, type);

        for (let g = 0; g < 12; g++) {
          // Alternate dragging the two ends — flips selectAnchor → re-roots the FK
          // on each gesture (the D6 trigger).
          const draggedId = g % 2 === 0 ? (pieces[pieces.length - 1] as TrackPiece).id : 'p0';
          const anchorId = selectAnchor(pieces, draggedId);
          const flex: FlexState = solveFollow(pieces, draggedId, {
            x: 80 + rand() * 700,
            y: 60 + rand() * 480,
          });
          const baked = [...applyFlex(pieces, flex, anchorId)];
          assertGestureSound(pieces, baked, anchorId, g);
          pieces = baked;

          // Every third gesture, ADD onto an end (extends the chain → the next
          // anchor shifts further — the report's "flex then add" compounding).
          if (g % 3 === 2) {
            const end = getEndpoints(pieces[pieces.length - 1] as TrackPiece)[1];
            if (end !== undefined) {
              const placement = computePlacement(end.x, end.y, type, pieces);
              pieces.push({
                id: `add${g}`,
                type,
                position: { x: placement.x, y: placement.y },
                rotationDeg: placement.rotationDeg,
                tagged: false,
              });
            }
          }
        }
      });
    }
  }
});
