/**
 * Tests for the ClosureWave component.
 *
 * Verifies:
 *   - `data-testid="closure-wave"` is present while the wave is active and
 *     absent after `onDone` fires.
 *   - The pulse position advances along the path as the clock advances.
 *   - `onDone` is called exactly once after `durationMs` has elapsed.
 *   - ToyTable-level: the wave mounts when a closure-committing drop occurs.
 */

import { act, render, screen } from '@testing-library/react';
import type { FlexState } from '@trainframe/simulator/track/flex.js';
import { type TrackPiece, getEndpoints } from '@trainframe/simulator/track/pieces.js';
import { computePlacement } from '@trainframe/simulator/track/placement.js';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ClosureWave } from './ClosureWave.js';
import { newLoopCenterline } from './ToyTable.js';

/* ---------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

/* A simple horizontal 3-point polyline spanning 0..200 mm. */
const SIMPLE_PATH = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 200, y: 0 },
];

/* Wrap ClosureWave in a minimal accessible SVG container for rendering in tests. */
function inSvg(node: React.ReactNode) {
  return (
    <svg role="img" aria-label="test canvas">
      {node}
    </svg>
  );
}

/*
 * Controllable clock: returns the current `time` reference.
 * Call `advance(dt)` to move it forward.
 */
function makeControllableClock(start = 0): { now: () => number; advance: (dt: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (dt: number) => {
      time += dt;
    },
  };
}

/*
 * Fake requestAnimationFrame that synchronously queues one callback per call,
 * so tests can flush frames by calling `flushRaf()` without real timers.
 * Returns a restore function.
 */
function fakeRaf(): { flush: () => void; restore: () => void } {
  const queue: Array<FrameRequestCallback> = [];
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  /* Stub requestAnimationFrame to enqueue immediately. */
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  return {
    flush: () => {
      const pending = queue.splice(0);
      for (const cb of pending) cb(0);
    },
    restore: () => {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCaf;
    },
  };
}

/* ---------------------------------------------------------------------------
 * ClosureWave unit tests
 * --------------------------------------------------------------------------- */

describe('ClosureWave', () => {
  it('renders data-testid="closure-wave" while active', () => {
    const raf = fakeRaf();
    try {
      const clock = makeControllableClock(0);
      const onDone = vi.fn();

      render(
        inSvg(
          <ClosureWave
            pathPoints={SIMPLE_PATH}
            durationMs={1000}
            now={clock.now}
            onDone={onDone}
          />,
        ),
      );

      /* Flush one frame so the RAF tick runs and sets t > 0 (or t = 0 on first frame). */
      act(() => raf.flush());

      expect(screen.getByTestId('closure-wave')).toBeInTheDocument();
    } finally {
      raf.restore();
    }
  });

  it('progresses to completion with the DEFAULT clock (no now prop)', () => {
    /*
     * Regression: the default `now` must be a STABLE reference. If it is created
     * fresh on every render (`now = () => performance.now()` as a default param),
     * the animation effect (deps [durationMs, now]) re-runs on every setT,
     * resetting the start time — so `t` never accumulates and the pulse sticks at
     * the start point forever (the wave looks frozen in production, even though
     * every test that passes an explicit stable clock still passes). Driving the
     * REAL default path here (no `now` prop, performance.now mocked to advance)
     * the wave must still reach the end and call onDone.
     */
    const raf = fakeRaf();
    let t = 0;
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => t);
    try {
      const onDone = vi.fn();
      render(inSvg(<ClosureWave pathPoints={SIMPLE_PATH} durationMs={1000} onDone={onDone} />));
      /* Advance well past the duration, flushing frames as a real clock would. */
      for (let i = 0; i < 15 && onDone.mock.calls.length === 0; i++) {
        t += 200;
        act(() => raf.flush());
      }
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      perfSpy.mockRestore();
      raf.restore();
    }
  });

  it('the wave SPREADS around the loop as the clock advances (front + lit grow)', () => {
    const raf = fakeRaf();
    try {
      const clock = makeControllableClock(0);
      const onDone = vi.fn();

      render(
        inSvg(
          <ClosureWave
            pathPoints={SIMPLE_PATH}
            durationMs={1000}
            now={clock.now}
            onDone={onDone}
          />,
        ),
      );

      const front = () =>
        Number.parseFloat(screen.getByTestId('closure-wave').getAttribute('data-front') ?? '0');
      const lit = () =>
        Number.parseInt(screen.getByTestId('closure-wave').getAttribute('data-lit') ?? '0', 10);

      /* Early in the spread: the fronts have only just left the seam. */
      act(() => raf.flush());
      const frontEarly = front();
      const litEarly = lit();

      /* Half-way: the fronts have advanced and more of the ring is lit. */
      clock.advance(350);
      act(() => raf.flush());
      const frontMid = front();
      const litMid = lit();

      expect(frontMid).toBeGreaterThan(frontEarly);
      expect(litMid).toBeGreaterThan(litEarly);

      /* The blue glow rides the rail — segments are <line>s, not a single dot. */
      const lines = screen.getByTestId('closure-wave').querySelectorAll('line');
      expect(lines.length).toBeGreaterThan(0);
      /* And it is blue, not a yellow pulse. */
      const stroke = lines[0]?.getAttribute('stroke') ?? '';
      expect(stroke.toLowerCase()).not.toBe('#ffe066');
      expect(/#(38bdf8|bae6fd)/i.test(stroke)).toBe(true);
    } finally {
      raf.restore();
    }
  });

  it('calls onDone and removes data-testid after durationMs', () => {
    const raf = fakeRaf();
    try {
      const clock = makeControllableClock(0);
      const onDone = vi.fn();

      const { unmount } = render(
        inSvg(
          <ClosureWave
            pathPoints={SIMPLE_PATH}
            durationMs={1000}
            now={clock.now}
            onDone={onDone}
          />,
        ),
      );

      /* Flush first frame (records start). */
      act(() => raf.flush());
      expect(screen.getByTestId('closure-wave')).toBeInTheDocument();

      /* Advance past durationMs. */
      clock.advance(1001);
      act(() => raf.flush());

      /* onDone fired; wave node removed. */
      expect(onDone).toHaveBeenCalledOnce();
      expect(screen.queryByTestId('closure-wave')).not.toBeInTheDocument();

      unmount();
    } finally {
      raf.restore();
    }
  });

  it('data-testid absent after onDone fires', () => {
    const raf = fakeRaf();
    try {
      const clock = makeControllableClock(0);
      const onDone = vi.fn();

      render(
        inSvg(
          <ClosureWave pathPoints={SIMPLE_PATH} durationMs={500} now={clock.now} onDone={onDone} />,
        ),
      );

      act(() => raf.flush());
      clock.advance(600);
      act(() => raf.flush());

      expect(screen.queryByTestId('closure-wave')).not.toBeInTheDocument();
    } finally {
      raf.restore();
    }
  });

  it('does not render for a single-point path', () => {
    const raf = fakeRaf();
    try {
      const clock = makeControllableClock(0);
      const onDone = vi.fn();

      render(
        inSvg(
          <ClosureWave
            pathPoints={[{ x: 0, y: 0 }]}
            durationMs={1000}
            now={clock.now}
            onDone={onDone}
          />,
        ),
      );

      act(() => raf.flush());

      /* Degenerate path — nothing rendered. */
      expect(screen.queryByTestId('closure-wave')).not.toBeInTheDocument();
    } finally {
      raf.restore();
    }
  });
});

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
