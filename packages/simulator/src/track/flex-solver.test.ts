import { describe, expect, it } from 'vitest';
import { selectAnchor, solveFollow } from './flex-solver.js';
import { FLEX_BUDGET_DEG, effectivePoses, jointKey } from './flex.js';
import { buildJoints } from './loops.js';
import { type RotationDeg, type TrackPiece, getEndpoints, getEndpointsAt } from './pieces.js';
import { computePlacement } from './placement.js';

/* ---------------------------------------------------------------------------
 * Layout builder helpers — mirrored from loops.test.ts / placement.test.ts
 * --------------------------------------------------------------------------- */

function piece(
  id: string,
  type: TrackPiece['type'],
  x: number,
  y: number,
  rot: RotationDeg,
): TrackPiece {
  return { id, type, position: { x, y }, rotationDeg: rot, tagged: false };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/*
 * Eight curves snapped end-to-end to form a closed circle (ids C0..C7).
 * Mirrors the builder in loops.test.ts.
 */
function buildEightCurveCircle(): TrackPiece[] {
  const pieces: TrackPiece[] = [];

  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push(piece('C0', 'curve', first.x, first.y, first.rotationDeg));

  for (let i = 1; i < 8; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const placement = computePlacement(exit.x, exit.y, 'curve', pieces);
    pieces.push(piece(`C${i}`, 'curve', placement.x, placement.y, placement.rotationDeg));
  }

  return pieces;
}

/*
 * An eight-curve circle with C0 replaced by a junction (id 'JN'), so the
 * ring still has 8 pieces and the junction's branch is a dangling spur.
 */
function buildLoopWithOneJunction(): TrackPiece[] {
  const circles = buildEightCurveCircle();
  const c0 = circles[0];
  if (c0 === undefined) throw new Error('unreachable');

  const junctionPiece: TrackPiece = {
    id: 'JN',
    type: 'junction',
    position: c0.position,
    rotationDeg: c0.rotationDeg,
    tagged: false,
  };

  return [junctionPiece, ...circles.slice(1)];
}

/*
 * An open chain of five straights: S0 at origin, each snapped to the east
 * endpoint of the previous. The dragged piece is S4 (the last).
 */
function buildOpenChainOfFive(): TrackPiece[] {
  const pieces: TrackPiece[] = [];
  pieces.push(piece('S0', 'straight', 0, 0, 0));

  for (let i = 1; i < 5; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const placement = computePlacement(exit.x, exit.y, 'straight', pieces);
    pieces.push(piece(`S${i}`, 'straight', placement.x, placement.y, placement.rotationDeg));
  }

  return pieces;
}

/* ---------------------------------------------------------------------------
 * selectAnchor
 * --------------------------------------------------------------------------- */

describe('selectAnchor', () => {
  it('prefers a junction piece as the anchor', () => {
    const layout = buildLoopWithOneJunction();
    /* 'JN' is the junction; drag any other curve piece */
    expect(selectAnchor(layout, 'C1')).toBe('JN');
  });

  it('does not return the dragged piece as the anchor even if it is the junction', () => {
    const layout = buildLoopWithOneJunction();
    /* When dragging the junction itself, fall back to the far piece */
    const anchor = selectAnchor(layout, 'JN');
    expect(anchor).not.toBe('JN');
  });

  it('falls back to the far piece (opposite side) when there is no junction', () => {
    const circle = buildEightCurveCircle();
    /* Dragging C0: the piece farthest around the ring is C4 */
    expect(selectAnchor(circle, 'C0')).toBe('C4');
  });

  it('open chain — anchor is the far end from the dragged piece', () => {
    const chain = buildOpenChainOfFive();
    /* Dragging S4 (far east end): anchor should be S0 */
    expect(selectAnchor(chain, 'S4')).toBe('S0');
  });
});

/* ---------------------------------------------------------------------------
 * solveFollow
 * --------------------------------------------------------------------------- */

describe('solveFollow', () => {
  it('every joint stays within ±FLEX_BUDGET_DEG', () => {
    const circle = buildEightCurveCircle();
    /* Derive the rest-pose handle of C0 */
    const c0 = circle.find((p) => p.id === 'C0');
    if (c0 === undefined) throw new Error('unreachable');
    const restPoses = effectivePoses(circle, new Map(), 'C0');
    const c0Pose = restPoses.get('C0') ?? {
      x: c0.position.x,
      y: c0.position.y,
      rotationDeg: c0.rotationDeg,
    };
    const handle = getEndpointsAt(c0, c0Pose)[0] ?? { x: c0.position.x + 40, y: c0.position.y };

    /* Target: 40 mm radially outward from the rest handle */
    const target = { x: handle.x + 40, y: handle.y };

    const flex = solveFollow(circle, 'C0', target);

    for (const jf of flex.values()) {
      expect(Math.abs(jf.deg)).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 1e-6);
    }
  });

  it('moves the dragged piece toward the target (reachable within budget)', () => {
    const chain = buildOpenChainOfFive();
    const draggedId = 'S4';
    const anchor = selectAnchor(chain, draggedId);

    /* Rest-pose handle: east endpoint of S4 */
    const s4 = chain.find((p) => p.id === draggedId);
    if (s4 === undefined) throw new Error('unreachable');
    const restPoses = effectivePoses(chain, new Map(), anchor);
    const s4Rest = restPoses.get(draggedId) ?? {
      x: s4.position.x,
      y: s4.position.y,
      rotationDeg: s4.rotationDeg,
    };
    /* East endpoint = index 1 for a straight */
    const restHandle = getEndpointsAt(s4, s4Rest)[1] ?? {
      x: s4.position.x + 100,
      y: s4.position.y,
    };

    /* Target: 5 mm north of the rest handle — small enough to be reachable */
    const target = { x: restHandle.x, y: restHandle.y - 5 };

    const flex = solveFollow(chain, draggedId, target);
    const flexedPoses = effectivePoses(chain, flex, anchor);
    const s4Flexed = flexedPoses.get(draggedId);
    if (s4Flexed === undefined) throw new Error('poses did not include dragged piece');

    const flexedHandle = getEndpointsAt(s4, s4Flexed)[1] ?? {
      x: s4.position.x + 100,
      y: s4.position.y,
    };

    expect(dist(flexedHandle, target)).toBeLessThan(dist(restHandle, target));
  });

  it('the anchor piece stays at its rest pose regardless of flex applied', () => {
    const chain = buildOpenChainOfFive();
    const draggedId = 'S4';
    const anchor = selectAnchor(chain, draggedId);

    const restPoses = effectivePoses(chain, new Map(), anchor);
    const anchorRest = restPoses.get(anchor);
    if (anchorRest === undefined) throw new Error('anchor not in rest poses');

    const flex = solveFollow(chain, draggedId, { x: 900, y: 50 });

    const flexedPoses = effectivePoses(chain, flex, anchor);
    const anchorFlexed = flexedPoses.get(anchor);
    if (anchorFlexed === undefined) throw new Error('anchor not in flexed poses');

    /* The anchor piece must not move — it is the fixed root. */
    expect(anchorFlexed.x).toBeCloseTo(anchorRest.x, 6);
    expect(anchorFlexed.y).toBeCloseTo(anchorRest.y, 6);
    expect(anchorFlexed.rotationDeg).toBeCloseTo(anchorRest.rotationDeg, 6);
  });

  it('returns an empty flex state when there are no joints to flex', () => {
    /* A single isolated piece — no joints at all */
    const solo: TrackPiece[] = [piece('SOLO', 'straight', 0, 0, 0)];
    const flex = solveFollow(solo, 'SOLO', { x: 500, y: 200 });
    expect(flex.size).toBe(0);
  });
});
