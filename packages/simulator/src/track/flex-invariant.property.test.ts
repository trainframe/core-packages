import { describe, expect, it } from 'vitest';
import { solveFollow } from './flex-solver.js';
import { FLEX_BUDGET_DEG, applyFlex } from './flex.js';
import type { FlexState } from './flex.js';
import { buildJoints, connectedComponents } from './loops.js';
import { type TrackPiece, getEndpoints } from './pieces.js';
import { computePlacement } from './placement.js';

/**
 * Authoritative-connection INVARIANT property test (goal criterion 3).
 *
 * Over a seeded, randomized sequence of flex drags on generated chains, the
 * authoritative invariant must hold on EVERY frame:
 *   - the chain's connected-assembly count never changes (no false sever from
 *     flexing, no false merge) — i.e. rendered connectivity equals the geometric
 *     joint graph throughout;
 *   - no joint over-bends past the flex budget (the rails stay seated, not kinked).
 *
 * The drag always solves against the REST poses (the single geometric source),
 * so flex is transient and the baked result equals what is rendered.
 */

/* Deterministic PRNG (mulberry32) — seeded, no Math.random, fully reproducible. */
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

/* A chain of `n` curves snapped end-to-end via the real placement path (an open
   arc: exactly one connected component, two open ends). */
function curveChain(n: number): TrackPiece[] {
  const pieces: TrackPiece[] = [];
  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push({
    id: 'c0',
    type: 'curve',
    position: { x: first.x, y: first.y },
    rotationDeg: first.rotationDeg,
    tagged: false,
  });
  for (let i = 1; i < n; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const p = computePlacement(exit.x, exit.y, 'curve', pieces);
    pieces.push({
      id: `c${i}`,
      type: 'curve',
      position: { x: p.x, y: p.y },
      rotationDeg: p.rotationDeg,
      tagged: false,
    });
  }
  return pieces;
}

/* Largest off-45°-grid deviation across all joints of a (baked) layout. */
function maxJointDeviation(pieces: ReadonlyArray<TrackPiece>): number {
  let max = 0;
  for (const j of buildJoints(pieces)) {
    const a = pieces.find((p) => p.id === j.a.pieceId);
    const b = pieces.find((p) => p.id === j.b.pieceId);
    if (a === undefined || b === undefined) continue;
    const rel = b.rotationDeg - a.rotationDeg;
    max = Math.max(max, Math.abs(rel - Math.round(rel / 45) * 45));
  }
  return max;
}

describe('flex invariant — randomized drags never sever or over-bend (criterion 3)', () => {
  for (const seed of [1, 7, 42, 1234, 99999]) {
    it(`seed ${seed}: assembly count and joint budget hold every frame`, () => {
      const rand = rng(seed);
      /* A chain of 3..7 curves (a partial arc — one open component). */
      const n = 3 + Math.floor(rand() * 5);
      let pieces = curveChain(n);
      const baselineComponents = connectedComponents(pieces).length;
      expect(baselineComponents).toBe(1);

      /* Drag the open END piece (last placed) over a random walk of targets,
         warm-starting each frame, baking between frames (single coordinate
         frame), exactly as the toy table does. */
      const draggedId = `c${n - 1}`;
      let seedFlex: FlexState | undefined;

      for (let frame = 0; frame < 40; frame++) {
        /* Random target anywhere in a generous box around the layout — well
           beyond flex reach much of the time, so the chain rubber-bands. */
        const tx = 100 + rand() * 600;
        const ty = 80 + rand() * 500;
        const flex = solveFollow(pieces, draggedId, { x: tx, y: ty }, seedFlex);
        seedFlex = flex;

        /* Render = apply the transient flex; this is the single geometric source
           the toy table renders and (on release) bakes. */
        const baked = [...applyFlex(pieces, flex)];

        /* INVARIANT 1: connectivity is unchanged — flexing never severs a seated
           joint nor merges a new one. Rendered assemblies == geometric. */
        expect(connectedComponents(baked).length).toBe(baselineComponents);

        /* INVARIANT 2: no joint over-bends past the flex budget. */
        expect(maxJointDeviation(baked)).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 0.01);

        /* Occasionally BAKE (commit) and continue from the baked poses, as a
           release would — the budget must stay absolute across stints. */
        if (frame % 8 === 7) {
          pieces = baked;
          seedFlex = undefined;
          expect(connectedComponents(pieces).length).toBe(baselineComponents);
          expect(maxJointDeviation(pieces)).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 0.01);
        }
      }
    });
  }
});
