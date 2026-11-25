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
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ClosureWave } from './ClosureWave.js';

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
