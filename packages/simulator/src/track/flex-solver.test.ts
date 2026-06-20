import { describe, expect, it } from 'vitest';
import { type ClosureResult, selectAnchor, solveClose, solveFollow } from './flex-solver.js';
import { FLEX_BUDGET_DEG, effectivePoses, jointKey } from './flex.js';
import { buildJoints, findLoops } from './loops.js';
import {
  type RotationDeg,
  type TrackEndpoint,
  type TrackPiece,
  getEndpoints,
  getEndpointsAt,
} from './pieces.js';
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

/*
 * An OPEN chain of `n` curves snapped end-to-end (ids C0..C{n-1}) but NOT
 * joined back into a ring. For n < 8 this is a genuine open arc — findLoops
 * sees no cycle — so the dragged piece's free endpoint is a real free end.
 */
function buildOpenCurveChain(n: number): TrackPiece[] {
  const pieces: TrackPiece[] = [];
  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push(piece('C0', 'curve', first.x, first.y, first.rotationDeg));
  for (let i = 1; i < n; i++) {
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
 * A closure target that is the dragged piece's rest free-endpoint pose rigidly
 * swung `swingDeg` about the anchor centre. The swing keeps the target
 * kinematically reachable by a few flexed joints (the CCD drives position only,
 * so an arbitrary nudge would leave a heading the solver can't fix). Returns the
 * target endpoint (with anti-parallel outgoing) and the rest-pose gap to it.
 */
function swungClosureTarget(
  pieces: ReadonlyArray<TrackPiece>,
  anchorId: string,
  dragged: TrackPiece,
  freeEndpointIdx: number,
  swingDeg: number,
): { target: TrackEndpoint; restGap: number } {
  const restPoses = effectivePoses(pieces, new Map(), anchorId);
  const anchorPose = restPoses.get(anchorId);
  const draggedPose = restPoses.get(dragged.id);
  if (anchorPose === undefined || draggedPose === undefined) throw new Error('unreachable');
  const restFree = getEndpointsAt(dragged, draggedPose)[freeEndpointIdx];
  if (restFree === undefined) throw new Error('unreachable');
  const rad = (swingDeg * Math.PI) / 180;
  const vx = restFree.x - anchorPose.x;
  const vy = restFree.y - anchorPose.y;
  const target: TrackEndpoint = {
    x: anchorPose.x + vx * Math.cos(rad) - vy * Math.sin(rad),
    y: anchorPose.y + vx * Math.sin(rad) + vy * Math.cos(rad),
    /* Anti-parallel at the swung pose: the free heading swings by swingDeg too. */
    outgoingAngleDeg: restFree.outgoingAngleDeg + swingDeg - 180,
    layer: 0,
  };
  return { target, restGap: dist(restFree, target) };
}

/* Smallest |angle| (deg) between `heading` and anti-parallel to `targetOutgoing`. */
function antiParallelHeadingError(heading: number, targetOutgoing: number): number {
  let d = (heading - (targetOutgoing + 180)) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return Math.abs(d);
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

/* ---------------------------------------------------------------------------
 * solveClose
 * --------------------------------------------------------------------------- */

/*
 * Build an 8-curve ring laid out as a snapped open chain (C0..C7 connected end
 * to end but NOT joined back). The free endpoint of C7 naturally falls very close
 * to C0's entry endpoint (within < 1 mm) because 8 × 45° = 360° — so the ring
 * nearly closes at rest. This layout is the "almost-closed" test case:
 * the solver must bring the free endpoint of C7 onto C0's entry within budget.
 *
 * Returns the pieces and the target endpoint (C0's entry, anti-parallel).
 */
function buildNearlyClosedRing(): {
  pieces: TrackPiece[];
  draggedId: string;
  freeEndpointIdx: number;
  target: TrackEndpoint;
} {
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

  /* The target is C0's entry endpoint (index 0). The free endpoint is C7's exit
   * (index 1). The two endpoints are anti-parallel when the ring closes. */
  const c0 = pieces[0];
  if (c0 === undefined) throw new Error('unreachable');
  const entry = getEndpoints(c0)[0];
  if (entry === undefined) throw new Error('unreachable');

  return { pieces, draggedId: 'C7', freeEndpointIdx: 1, target: entry };
}

/*
 * Build a ring whose closing gap is ~30 mm — far beyond what the combined joint
 * budget (7 joints × 2° each) can cover at the radius of the 8-curve circle.
 * Achieved by replacing C7 with a straight (a fundamentally different geometry)
 * and retaining C0's entry as the target, so the heading and/or position error
 * after relaxation will exceed tolerance.
 */
function buildRingWithExcessiveGap(): {
  pieces: TrackPiece[];
  draggedId: string;
  freeEndpointIdx: number;
  target: TrackEndpoint;
} {
  /* Build the first 7 curves as a chain. */
  const pieces: TrackPiece[] = [];
  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push(piece('C0', 'curve', first.x, first.y, first.rotationDeg));

  for (let i = 1; i < 7; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const placement = computePlacement(exit.x, exit.y, 'curve', pieces);
    pieces.push(piece(`C${i}`, 'curve', placement.x, placement.y, placement.rotationDeg));
  }

  /* Attach a straight as the dragged piece instead of the 8th curve.
   * A straight extends eastward from C6's exit; it cannot curve back toward C0,
   * leaving a gap of ~200 mm which is orders of magnitude beyond budget. */
  const c6 = pieces[6];
  if (c6 === undefined) throw new Error('unreachable');
  const c6Exit = getEndpoints(c6)[1];
  if (c6Exit === undefined) throw new Error('unreachable');
  const straightPlacement = computePlacement(c6Exit.x, c6Exit.y, 'straight', pieces);
  pieces.push(
    piece(
      'S7',
      'straight',
      straightPlacement.x,
      straightPlacement.y,
      straightPlacement.rotationDeg,
    ),
  );

  /* Target is still C0's entry endpoint. */
  const c0 = pieces[0];
  if (c0 === undefined) throw new Error('unreachable');
  const entry = getEndpoints(c0)[0];
  if (entry === undefined) throw new Error('unreachable');

  return { pieces, draggedId: 'S7', freeEndpointIdx: 1, target: entry };
}

/*
 * Position gap between a computed endpoint and the target position.
 */
function gapAt(
  poses: ReadonlyMap<string, { x: number; y: number; rotationDeg: number }>,
  draggedPiece: TrackPiece,
  freeEndpointIdx: number,
  target: { x: number; y: number },
): number {
  const pose = poses.get(draggedPiece.id);
  if (pose === undefined) return Number.POSITIVE_INFINITY;
  const ep = getEndpointsAt(draggedPiece, pose)[freeEndpointIdx];
  if (ep === undefined) return Number.POSITIVE_INFINITY;
  return Math.hypot(ep.x - target.x, ep.y - target.y);
}

describe('solveClose', () => {
  it('closes a near-complete ring whose residual is within total budget', () => {
    const { pieces, draggedId, freeEndpointIdx, target } = buildNearlyClosedRing();
    const res: ClosureResult = solveClose(pieces, draggedId, freeEndpointIdx, target);
    expect(res.feasible).toBe(true);

    const anchorId = selectAnchor(pieces, draggedId);
    const poses = effectivePoses(pieces, res.flex, anchorId);
    const dragged = pieces.find((p) => p.id === draggedId);
    if (dragged === undefined) throw new Error('unreachable');

    expect(gapAt(poses, dragged, freeEndpointIdx, target)).toBeLessThan(1.0);
  });

  it('refuses when the residual exceeds the combined budget', () => {
    const { pieces, draggedId, freeEndpointIdx, target } = buildRingWithExcessiveGap();
    expect(solveClose(pieces, draggedId, freeEndpointIdx, target).feasible).toBe(false);
  });

  it('returns feasible:false for a single isolated piece (no joints)', () => {
    const solo: TrackPiece[] = [piece('SOLO', 'straight', 0, 0, 0)];
    const target: TrackEndpoint = { x: 500, y: 200, outgoingAngleDeg: 180, layer: 0 };
    expect(solveClose(solo, 'SOLO', 0, target).feasible).toBe(false);
  });

  it('closes a genuine non-zero gap with non-empty flex', () => {
    /*
     * The other closure tests use the 8-curve ring, which closes EXACTLY at
     * rest (8 × 45° = 360°): the residual is 0 mm and the solver returns an
     * empty flex — so they never prove the solver actually FLEXES a real gap
     * shut. This test builds a genuinely OPEN chain (a quarter-ring of four
     * curves; findLoops sees no cycle) and asks the solver to close a real,
     * non-zero gap that the ±FLEX_BUDGET_DEG-per-joint budget can reach.
     *
     * To make the gap kinematically reachable (the CCD drives position only;
     * heading is a feasibility gate), the target is the rest free-endpoint pose
     * rigidly swung a small angle about the anchor — exactly the kind of small
     * rotation a few flexed joints can reproduce. The swing here is ~10 mm of
     * positional gap, well within the chain's reach but far from zero.
     */
    const chain = buildOpenCurveChain(4);
    const draggedId = 'C3';
    const freeEndpointIdx = 1;
    const anchorId = selectAnchor(chain, draggedId);
    const dragged = chain.find((p) => p.id === draggedId);
    if (dragged === undefined) throw new Error('unreachable');

    /* The chain is genuinely open — no cycle exists at rest. */
    expect(findLoops(chain)).toHaveLength(0);

    const { target, restGap } = swungClosureTarget(chain, anchorId, dragged, freeEndpointIdx, 1.5);

    /* The gap the solver must close is real and well above 1 mm. */
    expect(restGap).toBeGreaterThan(5);

    const res: ClosureResult = solveClose(chain, draggedId, freeEndpointIdx, target);

    /* Feasible, and the flex is genuinely non-empty (joints actually rotated). */
    expect(res.feasible).toBe(true);
    const flexedJoints = [...res.flex.values()].filter((f) => Math.abs(f.deg) > 1e-6);
    expect(flexedJoints.length).toBeGreaterThan(0);
    for (const f of flexedJoints) {
      expect(Math.abs(f.deg)).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 1e-6);
    }

    /* Applying the flex brings the free endpoint onto the target: position
     * gap < 1 mm and heading anti-parallel within 1°. */
    const closedPoses = effectivePoses(chain, res.flex, anchorId);
    expect(gapAt(closedPoses, dragged, freeEndpointIdx, target)).toBeLessThan(1.0);
    const closedPose = closedPoses.get(draggedId);
    if (closedPose === undefined) throw new Error('unreachable');
    const closedFree = getEndpointsAt(dragged, closedPose)[freeEndpointIdx];
    if (closedFree === undefined) throw new Error('unreachable');
    const headingErr = antiParallelHeadingError(
      closedFree.outgoingAngleDeg,
      target.outgoingAngleDeg,
    );
    expect(headingErr).toBeLessThan(1.0);
  });
});
