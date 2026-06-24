import { describe, expect, it } from 'vitest';
import { selectAnchor, solveFollow } from './flex-solver.js';
import { applyFlex } from './flex.js';
import { connectedComponents } from './loops.js';
import { type TrackPiece, getEndpoints } from './pieces.js';
import { computePlacement } from './placement.js';

/**
 * THE captured root cause of the "vanish" report (goal A, criteria 1–3),
 * reproduced RED on the original flex commit `38423a5` and FIXED in current code.
 *
 * Original bug: `effectivePoses` rendered the flex by walking a spanning tree
 * from a SINGLE anchor (`walkTree`) and returning ONLY the pieces it reached;
 * `loops.ts` had no `connectedComponents`. So whenever a flex render ran on a
 * layout with more than one connected component — e.g. you flex a chain and then
 * ADD a piece that lands as its own component, or a flex over-bends a joint past
 * the heading tolerance and SPLITS the chain — every piece NOT in the anchor's
 * component was omitted from the result and VANISHED from the render. Captured
 * live on `38423a5`: input `[a0, a1, b0]` → effectivePoses result `[a0, a1]` →
 * `b0` gone. Intermittent ("sometimes") because it only fires with >1 component;
 * the existing tests all flexed a SINGLE connected chain, so the walk reached
 * every piece and the bug never showed.
 *
 * Fix (current `applyFlex`, lines ~380–410): split into `connectedComponents`,
 * root each at its own anchor (the drag's anchor when it's in that component,
 * else the component's first piece), and `pieces.map(p => poses.get(p.id) ?? rest)`
 * — so EVERY input piece is in the output (FK pose, or its rest pose). No piece
 * can be dropped. These cases assert that invariant on the exact shapes that
 * dropped pieces before.
 */

/** Apply a real solved flex of `draggedId`'s chain to the whole `pieces` set and
   return the rendered (effective) ids — the set the toy table would draw. */
function renderedIdsUnderFlex(pieces: ReadonlyArray<TrackPiece>, draggedId: string): string[] {
  const anchor = selectAnchor(pieces, draggedId);
  const flex = solveFollow(pieces, draggedId, { x: 700, y: 500 });
  return [...applyFlex(pieces, flex, anchor)].map((p) => p.id).sort();
}

function curve(id: string, x: number, y: number, rot: number): TrackPiece {
  return { id, type: 'curve', position: { x, y }, rotationDeg: rot, tagged: false };
}

describe('multi-component flex render preserves every piece (root cause of the vanish)', () => {
  it('a flexed chain PLUS a detached piece: the detached piece is NOT dropped (was: vanished)', () => {
    // Chain A (two snapped curves) + a detached curve B far away = two components.
    const a0 = computePlacement(300, 250, 'curve', []);
    const p0 = curve('a0', a0.x, a0.y, a0.rotationDeg);
    const exit = getEndpoints(p0)[1];
    if (exit === undefined) throw new Error('no exit');
    const a1 = computePlacement(exit.x, exit.y, 'curve', [p0]);
    const p1 = curve('a1', a1.x, a1.y, a1.rotationDeg);
    const b0 = curve('b0', 750, 520, 0); // detached: its own component

    const pieces = [p0, p1, b0];
    expect(connectedComponents(pieces).length, 'two components').toBe(2);

    // Flex chain A (anchor in A's component); B is in the OTHER component.
    const rendered = renderedIdsUnderFlex(pieces, 'a1');
    expect(rendered, 'every piece still rendered — b0 not dropped').toEqual(['a0', 'a1', 'b0']);
  });

  it('place → flex → ADD a non-connecting piece: count preserved, all finite', () => {
    // Build + flex a connected chain, then add a detached piece (a 2nd component),
    // then render under the chain's flex — the exact place→flex→add shape.
    const c0 = computePlacement(300, 250, 'curve', []);
    const piece0 = curve('c0', c0.x, c0.y, c0.rotationDeg);
    const e = getEndpoints(piece0)[1];
    if (e === undefined) throw new Error('no exit');
    const c1 = computePlacement(e.x, e.y, 'curve', [piece0]);
    const piece1 = curve('c1', c1.x, c1.y, c1.rotationDeg);
    // ADD: a piece dropped in open space, NOT snapping onto the chain.
    const added = curve('added', 820, 80, 0);

    const pieces = [piece0, piece1, added];
    const anchor = selectAnchor(pieces, 'c1');
    const flex = solveFollow(pieces, 'c1', { x: 600, y: 480 });
    const out = [...applyFlex(pieces, flex, anchor)];

    expect(out.map((p) => p.id).sort(), 'no piece vanished').toEqual(['added', 'c0', 'c1']);
    for (const p of out) {
      expect(
        Number.isFinite(p.position.x) &&
          Number.isFinite(p.position.y) &&
          Number.isFinite(p.rotationDeg),
        `${p.id} finite`,
      ).toBe(true);
    }
  });

  it('three separate components under one flex: all pieces preserved', () => {
    const pieces = [curve('x0', 200, 200, 0), curve('y0', 600, 200, 0), curve('z0', 400, 500, 0)];
    expect(connectedComponents(pieces).length).toBe(3);
    // Even with a flex map solved for one piece, applyFlex returns all three.
    const flex = solveFollow(pieces, 'x0', { x: 250, y: 260 });
    const out = [...applyFlex(pieces, flex, selectAnchor(pieces, 'x0'))];
    expect(out.map((p) => p.id).sort()).toEqual(['x0', 'y0', 'z0']);
  });
});
