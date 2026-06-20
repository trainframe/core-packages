/**
 * ClosureWave — one-shot glow pulse that travels a polyline once and disappears.
 *
 * Used by ToyTable to celebrate a newly-closed loop: on drop the wave rides the
 * ring's rail centreline from its start point all the way around, then calls
 * `onDone` and unmounts itself.
 *
 * Animation uses requestAnimationFrame with an injectable `now` source so tests
 * can advance time deterministically without touching real timers.
 */

import { useEffect, useRef, useState } from 'react';

/* Accumulated arc-length distances from the first point (inclusive of 0). */
function buildCumLengths(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev === undefined || curr === undefined) continue;
    const d = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    cum.push((cum[cum.length - 1] ?? 0) + d);
  }
  return cum;
}

/* Interpolate world position at arc-length `dist` along the polyline. */
function sampleAt(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  cumLengths: number[],
  dist: number,
): { x: number; y: number } | null {
  const total = cumLengths[cumLengths.length - 1] ?? 0;
  if (points.length === 0 || total === 0) return null;
  const clamped = Math.max(0, Math.min(dist, total));
  return findSegmentAt(points, cumLengths, clamped);
}

/* Find the interpolated world point at arc-length `clamped` along the polyline. */
function findSegmentAt(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  cumLengths: number[],
  clamped: number,
): { x: number; y: number } | null {
  for (let i = 1; i < cumLengths.length; i++) {
    const segEnd = cumLengths[i];
    const segStart = cumLengths[i - 1];
    if (segEnd === undefined || segStart === undefined) continue;
    if (clamped > segEnd) continue;
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) return null;
    const span = segEnd - segStart;
    const t = span > 0 ? (clamped - segStart) / span : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  /* Past the end — return last point. */
  return points[points.length - 1] ?? null;
}

export interface ClosureWaveProps {
  /** World-space (mm) polyline vertices forming the loop centreline. */
  readonly pathPoints: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /** How long the full traversal takes, milliseconds. */
  readonly durationMs: number;
  /**
   * Clock source for the animation loop. Defaults to `performance.now`.
   * Override in tests to drive the clock deterministically.
   */
  readonly now?: () => number;
  /** Called once when the wave completes its traversal. */
  readonly onDone: () => void;
}

export function ClosureWave({
  pathPoints,
  durationMs,
  now = () => performance.now(),
  onDone,
}: ClosureWaveProps) {
  const cumLengths = useRef<number[]>(buildCumLengths(pathPoints));
  const totalLength = cumLengths.current[cumLengths.current.length - 1] ?? 0;

  /* t ∈ [0, 1]: progress through the traversal. */
  const [t, setT] = useState(0);
  const [done, setDone] = useState(false);

  /* Keep a stable ref to onDone so the RAF closure doesn't capture a stale callback. */
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const startRef = useRef<number | null>(null);

  useEffect(() => {
    /* Recompute cumulative lengths if pathPoints changes (shouldn't happen in
       normal use but guards against stale data in tests). */
    cumLengths.current = buildCumLengths(pathPoints);
  }, [pathPoints]);

  useEffect(() => {
    /* Reset the start time whenever the clock source or duration changes so the
       animation always begins from t=0 with the current clock. */
    startRef.current = null;
    let rafId: number | null = null;
    let finished = false;

    function tick() {
      if (finished) return;
      const current = now();
      if (startRef.current === null) startRef.current = current;
      const elapsed = current - startRef.current;
      const progress = Math.min(elapsed / durationMs, 1);
      setT(progress);
      if (progress >= 1) {
        finished = true;
        setDone(true);
        onDoneRef.current();
        return;
      }
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      finished = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [durationMs, now]);

  if (done || pathPoints.length < 2) return null;

  const pos = sampleAt(pathPoints, cumLengths.current, t * totalLength);
  if (pos === null) return null;

  /* Build polyline points string from world-space coords. The SVG viewBox is
     already in mm so no scaling is needed here — ToyTable's <svg> handles the
     mm→px scale via its viewBox/dimensions. */
  const polylinePoints = pathPoints.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <g data-testid="closure-wave" pointerEvents="none">
      {/* Dim trail along the whole ring. */}
      <polyline
        points={polylinePoints}
        fill="none"
        stroke="#ffe066"
        strokeWidth={4}
        strokeOpacity={0.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Bright leading pulse. */}
      <circle
        cx={pos.x}
        cy={pos.y}
        r={6}
        fill="#ffe066"
        fillOpacity={0.9}
        filter="url(#closure-wave-glow)"
      />
      <defs>
        <filter id="closure-wave-glow" x="-150%" y="-150%" width="400%" height="400%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
    </g>
  );
}
