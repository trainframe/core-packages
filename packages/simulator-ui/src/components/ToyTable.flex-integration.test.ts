/**
 * Real-solver integration test for the loop-closure path.
 *
 * Unlike ToyTable.flex.test.tsx, this file does NOT mock solveClose. The real
 * CCD solver runs against a 7-piece open chain that becomes a closed 8-piece
 * ring once the final curve is placed. The committed flex is validated end-to-end
 * by findLoops — confirming the topology is closed after applyFlex.
 *
 * What this tests that the mocked tests cannot:
 *   - The real solveClose correctly identifies the correct freeEndpointIdx and
 *     closure target — wrong args produce infeasible (proven by the negative check).
 *   - applyFlex applied to the solved flex produces effective positions that
 *     findLoops recognises as a cycle (the key invariant from the task-9 brief).
 *   - The 7-piece open chain has NO loops before assembly; after assembly it has
 *     exactly one loop — proving the topology transition is real, not pre-existing.
 */
import { type ClosureResult, solveClose } from '@trainframe/simulator/track/flex-solver.js';
import type { FlexState } from '@trainframe/simulator/track/flex.js';
import { buildJoints, findLoops } from '@trainframe/simulator/track/loops.js';
import {
  type RotationDeg,
  type TrackEndpoint,
  type TrackPiece,
  getEndpoints,
} from '@trainframe/simulator/track/pieces.js';
import { computePlacement } from '@trainframe/simulator/track/placement.js';
import { describe, expect, it } from 'vitest';
import { applyFlex } from './ToyTable.js';

/* ---------------------------------------------------------------------------
 * Layout builder helpers
 * --------------------------------------------------------------------------- */

function makeCurve(id: string, x: number, y: number, rot: RotationDeg): TrackPiece {
  return { id, type: 'curve', position: { x, y }, rotationDeg: rot, tagged: false };
}

/**
 * Build a 7-piece open curve chain (C0–C6) followed by a 8th closing curve C7.
 *
 * C0–C6 are snapped end-to-end via computePlacement. C7 is added last; its entry
 * endpoint snaps to C6's exit and its exit endpoint coincides with C0's entry —
 * this is the geometrically exact 8-curve circle (8 × 45° = 360°).
 *
 * Returns the 7-piece open chain separately so tests can assert the pre-assembly
 * state (6 joints, 0 loops) before asserting the post-assembly state (8 joints,
 * 1 loop).
 *
 * Notes on the ring geometry:
 *   - solveClose at rest-pose immediately converges (gap = 0 mm) and returns
 *     feasible=true with an empty flex — the CCD needs no iterations.
 *   - Wrong freeEndpointIdx (0 instead of 1) sends the solver toward the wrong
 *     endpoint; it cannot converge within budget → infeasible. This proves the
 *     solver is sensitive to arg wiring even when the rest-pose gap is zero.
 *   - findLoops on the 7-piece open chain returns [] (no cycle); findLoops on the
 *     8-piece closed chain (applyFlex applied) returns the one cycle.
 */
function buildEightCurveRing(): {
  openChain: TrackPiece[];
  pieces: TrackPiece[];
  draggedId: string;
  freeEndpointIdx: number;
  target: TrackEndpoint;
} {
  const pieces: TrackPiece[] = [];

  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push(makeCurve('C0', first.x, first.y, first.rotationDeg as RotationDeg));

  for (let i = 1; i < 7; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const pl = computePlacement(exit.x, exit.y, 'curve', pieces);
    pieces.push(makeCurve(`C${i}`, pl.x, pl.y, pl.rotationDeg as RotationDeg));
  }

  /* Snapshot the 7-piece open chain before adding C7. */
  const openChain: TrackPiece[] = [...pieces];

  /* Place C7 — computePlacement snaps its entry to C6's exit; the 8-curve
   * geometry guarantees C7's exit lands exactly on C0's entry (360° total). */
  const c6 = pieces[6];
  if (c6 === undefined) throw new Error('unreachable');
  const c6Exit = getEndpoints(c6)[1];
  if (c6Exit === undefined) throw new Error('unreachable');
  const c7pl = computePlacement(c6Exit.x, c6Exit.y, 'curve', pieces);
  pieces.push(makeCurve('C7', c7pl.x, c7pl.y, c7pl.rotationDeg as RotationDeg));

  /* Target is C0's entry endpoint (index 0). Free endpoint is C7's exit (index 1). */
  const c0 = pieces[0];
  if (c0 === undefined) throw new Error('unreachable');
  const entry = getEndpoints(c0)[0];
  if (entry === undefined) throw new Error('unreachable');

  return { openChain, pieces, draggedId: 'C7', freeEndpointIdx: 1, target: entry };
}

/* ---------------------------------------------------------------------------
 * Integration test — real solveClose + findLoops cycle check
 * --------------------------------------------------------------------------- */

describe('real solveClose closure — findLoops confirms the cycle', () => {
  it('closes an 8-curve ring and findLoops finds the cycle after applyFlex', () => {
    /*
     * 1. Build the layout: 7-piece open chain + C7 (the closing piece).
     * 2. Verify the OPEN chain has 0 loops — proving the ring starts genuinely open.
     * 3. Run the REAL solveClose with CORRECT args (no mock).
     * 4. Verify solveClose is INFEASIBLE with wrong freeEndpointIdx — proving arg
     *    wiring is tested (wrong index → solver aims at the wrong endpoint).
     * 5. Apply the correctly-solved flex to get effective piece positions.
     * 6. Assert findLoops returns exactly one loop covering all 8 pieces.
     */

    const { openChain, pieces, draggedId, freeEndpointIdx, target } = buildEightCurveRing();

    /* Step 2 — open chain (7 pieces, 6 joints) must have no loop. */
    expect(buildJoints(openChain)).toHaveLength(6);
    expect(findLoops(openChain)).toHaveLength(0);

    /* Step 3 — real solver, no mock.
     * The 8-curve ring is geometrically exact (gap = 0 mm at rest pose), so the
     * CCD converges immediately and returns feasible=true with an empty flex.
     * This is correct: the ring IS closable (trivially — it is already closed). */
    const result: ClosureResult = solveClose(pieces, draggedId, freeEndpointIdx, target);
    expect(result.feasible).toBe(true);

    /* Step 4 — wrong freeEndpointIdx must fail.
     * Index 0 is C7's entry endpoint (at C6's exit, far from C0's entry). The CCD
     * cannot converge C7's ENTRY to C0's entry within the joint flex budget →
     * infeasible. This proves the solver is sensitive to the endpoint index arg. */
    const wrongIdxResult = solveClose(pieces, draggedId, 0, target);
    expect(wrongIdxResult.feasible).toBe(false);

    /* Step 5 — apply the solved flex (empty in this case; rest pose is already the
     * closed ring). applyFlex with an empty flex returns pieces at rest positions,
     * which is the correct closed topology. */
    const flex: FlexState = result.flex;
    const effective = applyFlex(pieces, flex);

    /* Lift to TrackPiece[] — sound because EffectivePiece differs from TrackPiece
     * only in the declared type of rotationDeg (number vs RotationDeg). With empty
     * flex, values ARE quantised; geometry functions accept any number. Same
     * pattern as asTrackPieces() in ToyTable.tsx. */
    const asTrackPieces = effective as unknown as ReadonlyArray<TrackPiece>;

    /* Step 6 — findLoops must return exactly one loop covering all 8 pieces. */
    expect(asTrackPieces).toHaveLength(8);

    const loops = findLoops(asTrackPieces);
    expect(loops).toHaveLength(1);

    const loop = loops[0];
    if (loop === undefined) throw new Error('unreachable');
    expect(loop.pieceIds).toHaveLength(8);
    expect(new Set(loop.pieceIds)).toEqual(
      new Set(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']),
    );

    /* Confirm 8 joints in the closed ring (one more than the 6-joint open chain). */
    const joints = buildJoints(asTrackPieces);
    expect(joints).toHaveLength(8);
  });
});
