import { describe, expect, it } from 'vitest';
import { detectLoopClosure, newLoopCenterline } from './closure.js';
import type { FlexState } from './flex.js';
import { type TrackPiece, getEndpoints } from './pieces.js';
import { computePlacement, openEndpoints } from './placement.js';

/* ---------------------------------------------------------------------------
 * newLoopCenterline — boundary tests
 *
 * The exported pure function returns null when no NEW loop is created by the
 * flex. A positive result (flex closes the final gap) requires real CCD output,
 * which is covered end-to-end by the ToyTable integration tests.
 * --------------------------------------------------------------------------- */

const EMPTY_FLEX: FlexState = new Map();

/* A real closed loop: 8 curves snapped end-to-end (each seats anti-parallel onto
   the previous), exactly as the editor builds one. Unlike the old straight
   "rectangle", every corner is a true seat, so it is a genuine cycle under the
   authoritative heading+proximity joint rule. */
function closedCircle(): TrackPiece[] {
  const pieces: TrackPiece[] = [];
  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push({
    id: 'c0',
    type: 'curve',
    position: { x: first.x, y: first.y },
    rotationDeg: first.rotationDeg,
    tagged: false,
  });
  for (let i = 1; i < 8; i++) {
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

/* Two curves seated end-to-end — an OPEN chain (no cycle). */
function openChain(): TrackPiece[] {
  const pieces: TrackPiece[] = [];
  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push({
    id: 'o0',
    type: 'curve',
    position: { x: first.x, y: first.y },
    rotationDeg: first.rotationDeg,
    tagged: false,
  });
  const exit = getEndpoints(pieces[0] as TrackPiece)[1];
  if (exit === undefined) throw new Error('unreachable');
  const p = computePlacement(exit.x, exit.y, 'curve', pieces);
  pieces.push({
    id: 'o1',
    type: 'curve',
    position: { x: p.x, y: p.y },
    rotationDeg: p.rotationDeg,
    tagged: false,
  });
  return pieces;
}

describe('newLoopCenterline', () => {
  it('returns null for an open 2-piece chain', () => {
    const chain = openChain();
    /* No cycle contains the dragged piece in an open chain. */
    expect(newLoopCenterline(chain, EMPTY_FLEX, 'o0')).toBeNull();
  });

  it('returns null when no cycle contains the dragged piece', () => {
    /* A genuine closed loop, but we ask for a piece id not in the layout — the
       guard branch must return null cleanly. */
    expect(newLoopCenterline(closedCircle(), EMPTY_FLEX, 'GHOST')).toBeNull();
  });

  it('fires when a drag completes a true 8-curve loop (wave fires) — criterion 4 positive', () => {
    /* The trigger fires on the closure commit: if the dragged piece is inside a
       cycle in the effective geometry, return the centreline. A genuine 8-curve
       ring is a real cycle → the wave fires. */
    const pts = newLoopCenterline(closedCircle(), EMPTY_FLEX, 'c0');
    expect(pts).not.toBeNull();
    expect(pts?.length).toBeGreaterThanOrEqual(2);
  });

  it('NEVER fires for the un-closeable 7-curve arc — criterion 4 negative', () => {
    /* The exact logged 7-curve arc: 315° of turning, 45° short of a loop. Its two
       open ends are ~153mm apart and 45° misaligned — no cycle exists, so dragging
       its open end can never complete one. The wave must never fire. */
    const arc: TrackPiece[] = [
      {
        id: 'curve-1',
        type: 'curve',
        position: { x: 372.8785357737105, y: 121.9178972545757 },
        rotationDeg: 0,
        tagged: false,
      },
      {
        id: 'curve-3',
        type: 'curve',
        position: { x: 481.1177558029499, y: 230.15711728381513 },
        rotationDeg: 45,
        tagged: false,
      },
      {
        id: 'curve-4',
        type: 'curve',
        position: { x: 481.11775580294983, y: 383.23049022985106 },
        rotationDeg: 90,
        tagged: false,
      },
      {
        id: 'curve-5',
        type: 'curve',
        position: { x: 372.8785357737104, y: 491.46971025909045 },
        rotationDeg: 135,
        tagged: false,
      },
      {
        id: 'curve-6',
        type: 'curve',
        position: { x: 219.8051628276746, y: 121.9178972545757 },
        rotationDeg: 315,
        tagged: false,
      },
      {
        id: 'curve-7',
        type: 'curve',
        position: { x: 111.56594279843522, y: 230.15711728381513 },
        rotationDeg: 270,
        tagged: false,
      },
      {
        id: 'curve-8',
        type: 'curve',
        position: { x: 111.56594279843522, y: 383.23049022985106 },
        rotationDeg: 225,
        tagged: false,
      },
    ];
    /* No cycle through the dragged open end (curve-8) → null → no wave. */
    expect(newLoopCenterline(arc, EMPTY_FLEX, 'curve-8')).toBeNull();
    /* And not through any other member either. */
    expect(newLoopCenterline(arc, EMPTY_FLEX, 'curve-5')).toBeNull();
  });
});

describe('openEndpoints', () => {
  it('reports both ends of a lone piece and none for a closed ring', () => {
    expect(openEndpoints(openChain().slice(0, 1))).toHaveLength(2);
    expect(openEndpoints(closedCircle())).toHaveLength(0);
  });

  it('excludes the named piece and treats its neighbour ends as open', () => {
    const open = openEndpoints(closedCircle(), 'c0');
    expect(open.every((ep) => ep.pieceId !== 'c0')).toBe(true);
    expect(open).toHaveLength(2);
  });
});

describe('detectLoopClosure', () => {
  it('returns null when the dragged piece has no open end within capture range', () => {
    const chain = openChain();
    expect(detectLoopClosure(chain, 'o1', EMPTY_FLEX, 'o0')).toBeNull();
  });

  it('returns null for an unknown dragged piece', () => {
    expect(detectLoopClosure(openChain(), 'GHOST', EMPTY_FLEX, 'o0')).toBeNull();
  });

  it('closes a seven-curve arc once the eighth curve sits at the gap', () => {
    const ring = closedCircle();
    const arc = ring.slice(0, 7);
    const last = ring[7] as TrackPiece;
    const result = detectLoopClosure([...arc, last], 'c7', EMPTY_FLEX, 'c0');
    expect(result?.feasible).toBe(true);
  });
});
