import { describe, expect, it } from 'vitest';
import { findLoops } from './loops.js';
import { type RotationDeg, type TrackPiece, getEndpoints } from './pieces.js';
import { computePlacement } from './placement.js';

/* Build a TrackPiece at the given position/rotation with a given id and type. */
function piece(
  id: string,
  type: TrackPiece['type'],
  x: number,
  y: number,
  rot: RotationDeg,
): TrackPiece {
  return { id, type, position: { x, y }, rotationDeg: rot, tagged: false };
}

/*
 * Build an 8-curve circle by snapping each curve to the previous, exactly as
 * the editor would. Mirrors the pattern from placement.test.ts:159.
 */
function buildEightCurveCircle(): TrackPiece[] {
  const pieces: TrackPiece[] = [];

  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push(piece('c0', 'curve', first.x, first.y, first.rotationDeg));

  for (let i = 1; i < 8; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const placement = computePlacement(exit.x, exit.y, 'curve', pieces);
    pieces.push(piece(`c${i}`, 'curve', placement.x, placement.y, placement.rotationDeg));
  }

  return pieces;
}

/*
 * Build a closed 8-curve circle with a junction inserted at c0 and a dangling
 * straight spur hanging off the branch endpoint. The junction replaces c0 so
 * the loop ring still has 8 pieces (one of which is the junction); the spur
 * piece carries id 'SPUR'.
 *
 * Strategy: build a normal 8-curve ring, then:
 *   - replace c0 with a junction (same position, same rotation) — trunk and
 *     main endpoints match the curve's two, branch is the spur attachment.
 *   - snap a straight onto the junction's branch endpoint.
 */
function buildCircleWithJunctionSpur(): TrackPiece[] {
  const circles = buildEightCurveCircle();

  /* Replace c0 with a junction at the same position/rotation. */
  const c0 = circles[0];
  if (c0 === undefined) throw new Error('unreachable');

  const junctionPiece: TrackPiece = {
    id: 'J',
    type: 'junction',
    position: c0.position,
    rotationDeg: c0.rotationDeg,
    tagged: false,
  };

  const withJunction: TrackPiece[] = [junctionPiece, ...circles.slice(1)];

  /* Find the junction's branch endpoint (index 2) and snap a straight onto it. */
  const branchEp = getEndpoints(junctionPiece)[2];
  if (branchEp === undefined) throw new Error('unreachable');
  const spurPlacement = computePlacement(branchEp.x, branchEp.y, 'straight', withJunction);
  const spurPiece: TrackPiece = {
    id: 'SPUR',
    type: 'straight',
    position: { x: spurPlacement.x, y: spurPlacement.y },
    rotationDeg: spurPlacement.rotationDeg,
    tagged: false,
  };

  return [...withJunction, spurPiece];
}

/*
 * Build an open chain of three straights, snapping each to the previous.
 * No loop closes — the chain is open at both ends.
 */
function buildOpenChainOfThree(): TrackPiece[] {
  const pieces: TrackPiece[] = [];

  pieces.push(piece('s0', 'straight', 0, 0, 0));

  for (let i = 1; i < 3; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const placement = computePlacement(exit.x, exit.y, 'straight', pieces);
    pieces.push(piece(`s${i}`, 'straight', placement.x, placement.y, placement.rotationDeg));
  }

  return pieces;
}

describe('findLoops', () => {
  it('finds the single cycle in an 8-curve circle', () => {
    const circle = buildEightCurveCircle();
    const loops = findLoops(circle);
    expect(loops).toHaveLength(1);
    expect(loops[0]?.pieceIds).toHaveLength(8);
  });

  it('ignores a spur: a circle with one extra straight hanging off a junction', () => {
    const circleWithSpur = buildCircleWithJunctionSpur();
    const loops = findLoops(circleWithSpur);
    expect(loops).toHaveLength(1);
    /* The spur piece is NOT part of the cycle. */
    expect(loops[0]?.pieceIds).not.toContain('SPUR');
  });

  it('returns no loops for an open chain', () => {
    expect(findLoops(buildOpenChainOfThree())).toEqual([]);
  });
});
