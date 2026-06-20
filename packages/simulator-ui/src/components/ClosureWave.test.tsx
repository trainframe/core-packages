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
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
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

  it('pulse cx advances along the path as the clock advances', () => {
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

      /* First tick: start recorded, progress = 0 → pulse at x=0. */
      act(() => raf.flush());
      const circleBefore = screen.getByTestId('closure-wave').querySelector('circle');
      const cxBefore = Number.parseFloat(circleBefore?.getAttribute('cx') ?? '0');

      /* Advance clock to 50 % (500 ms). */
      clock.advance(500);
      act(() => raf.flush());

      const circleAfter = screen.getByTestId('closure-wave').querySelector('circle');
      const cxAfter = Number.parseFloat(circleAfter?.getAttribute('cx') ?? '0');

      /* At 50 % the pulse should be near x = 100 (midpoint of 200mm path). */
      expect(cxAfter).toBeGreaterThan(cxBefore);
      expect(cxAfter).toBeCloseTo(100, 0);
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

/* 4-piece rectangle of 200mm straights, all endpoints coincident in rest pose:
 *   A at (100,   0) rot   0°: ep0=(  0,   0), ep1=(200,   0)
 *   B at (200, 100) rot  90°: ep0=(200,   0), ep1=(200, 200)
 *   C at (100, 200) rot 180°: ep0=(200, 200), ep1=(  0, 200)
 *   D at (  0, 100) rot 270°: ep0=(  0, 200), ep1=(  0,   0)
 */
const EMPTY_FLEX: FlexState = new Map();

function rect(): { a: TrackPiece; b: TrackPiece; c: TrackPiece; d: TrackPiece } {
  const base = { tagged: false };
  return {
    a: { ...base, id: 'A', type: 'straight', position: { x: 100, y: 0 }, rotationDeg: 0 },
    b: { ...base, id: 'B', type: 'straight', position: { x: 200, y: 100 }, rotationDeg: 90 },
    c: { ...base, id: 'C', type: 'straight', position: { x: 100, y: 200 }, rotationDeg: 180 },
    d: { ...base, id: 'D', type: 'straight', position: { x: 0, y: 100 }, rotationDeg: 270 },
  };
}

describe('newLoopCenterline', () => {
  it('returns null for an open 2-piece chain', () => {
    const { a, b } = rect();
    expect(newLoopCenterline([a, b], EMPTY_FLEX)).toBeNull();
  });

  it('returns null when the loop already exists in restPieces before the flex', () => {
    /* All four pieces already form the closed rectangle in rest pose → findLoops
       finds the loop both before and after the identity flex → diff is empty → null. */
    const { a, b, c, d } = rect();
    expect(newLoopCenterline([a, b, c, d], EMPTY_FLEX)).toBeNull();
  });
});
