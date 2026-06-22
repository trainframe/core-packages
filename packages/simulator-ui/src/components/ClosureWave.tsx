/**
 * ClosureWave — a blue energy wave that EMANATES from the closure seam and
 * spreads around the whole closed loop, then fades.
 *
 * On a loop closing, the seam (where the two ends just met) lights up and a blue
 * glow flows outward in BOTH directions around the rail centreline — two wave
 * fronts diverging around the ring, a bright leading edge with a gradient tail,
 * the loop filling with blue as the fronts race to meet at the far side, then
 * the whole ring fades out. It rides the loop's actual centreline, so it traces
 * the track around the closed area rather than sitting as a dot anywhere.
 *
 * Animation uses requestAnimationFrame with an injectable `now` source so tests
 * can advance time deterministically without touching real timers.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

/* Stable default clock. MUST be a module-level constant, not an inline default
   (`now = () => performance.now()`): an inline default is a fresh function on
   every render, so the animation effect (deps include `now`) would re-run on
   every frame and reset the start time — freezing the wave at the start. */
const defaultNow = (): number => performance.now();

/* Fraction of the run spent spreading the fronts around the loop; the remainder
   fades the whole ring out. */
const SPREAD_FRACTION = 0.75;
/* Arc-length (as a fraction of the half-perimeter) over which the bright leading
   edge fades back into the dimmer filled trail. */
const HEAD_FRACTION = 0.28;
/* Opacity of the filled trail the fronts leave behind (the leading edge is 1). */
const TRAIL_OPACITY = 0.32;

interface Pt {
  readonly x: number;
  readonly y: number;
}

/* Resample a (closed) polyline to `n` roughly evenly-spaced points and report the
   perimeter. The input from newLoopCenterline traces the loop once; we append the
   first point so the seam segment is included. */
function resampleLoop(points: ReadonlyArray<Pt>, n: number): { pts: Pt[]; perimeter: number } {
  const loop = points.length >= 2 ? [...points, points[0] as Pt] : [...points];
  const cum: number[] = [0];
  for (let i = 1; i < loop.length; i++) {
    const a = loop[i - 1] as Pt;
    const b = loop[i] as Pt;
    cum.push((cum[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const perimeter = cum[cum.length - 1] ?? 0;
  if (perimeter === 0) return { pts: [...points], perimeter: 0 };
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * perimeter;
    let seg = 1;
    while (seg < cum.length && (cum[seg] as number) < target) seg++;
    const s0 = cum[seg - 1] as number;
    const s1 = cum[seg] as number;
    const a = loop[seg - 1] as Pt;
    const b = loop[seg] as Pt;
    const f = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return { pts: out, perimeter };
}

export interface ClosureWaveProps {
  /** World-space (mm) polyline vertices forming the loop centreline. */
  readonly pathPoints: ReadonlyArray<Pt>;
  /** How long the full wave (spread + fade) takes, milliseconds. */
  readonly durationMs: number;
  /**
   * Clock source for the animation loop. Defaults to `performance.now`.
   * Override in tests to drive the clock deterministically.
   */
  readonly now?: () => number;
  /** Called once when the wave completes. */
  readonly onDone: () => void;
}

export function ClosureWave({
  pathPoints,
  durationMs,
  now = defaultNow,
  onDone,
}: ClosureWaveProps) {
  const { pts, perimeter } = useMemo(() => resampleLoop(pathPoints, 96), [pathPoints]);

  /* t ∈ [0, 1]: progress through spread (0..SPREAD_FRACTION) then fade (..1). */
  const [t, setT] = useState(0);
  const [done, setDone] = useState(false);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    startRef.current = null;
    let rafId: number | null = null;
    let finished = false;
    function tick() {
      if (finished) return;
      const current = now();
      if (startRef.current === null) startRef.current = current;
      const progress = Math.min((current - startRef.current) / durationMs, 1);
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

  if (done || pts.length < 2 || perimeter === 0) return null;

  /* spreadT advances the two wave fronts from the seam to the far side; fade
     dims the whole ring once they have met. */
  const spreadT = Math.min(t / SPREAD_FRACTION, 1);
  const fade =
    t <= SPREAD_FRACTION ? 1 : Math.max(0, 1 - (t - SPREAD_FRACTION) / (1 - SPREAD_FRACTION));
  const half = perimeter / 2;
  const front = spreadT * half; // arc-distance each front has reached from the seam
  const headLen = HEAD_FRACTION * half;

  /* Per-segment opacity: a segment at arc-distance d from the seam (measured the
     short way round, so it is symmetric in both directions) is lit once a front
     has reached it (d ≤ front). The leading edge (front − d small) is brightest;
     behind it the trail settles to TRAIL_OPACITY. Multiply by the global fade. */
  const segs: Array<{ i: number; x1: number; y1: number; x2: number; y2: number; o: number }> = [];
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i] as Pt;
    const b = pts[i + 1] as Pt;
    const midArc = ((i + 0.5) / n) * perimeter;
    const d = Math.min(midArc, perimeter - midArc); // short way from the seam
    if (d > front) continue;
    const behind = front - d;
    const head = Math.max(0, 1 - behind / headLen); // 1 at the front, 0 by headLen
    const o = (TRAIL_OPACITY + (1 - TRAIL_OPACITY) * head) * fade;
    if (o <= 0.01) continue;
    /* `i` is the segment's stable position in the ring — a sound React key (the
       array is filtered to lit segments, so its array index is not stable). */
    segs.push({ i, x1: a.x, y1: a.y, x2: b.x, y2: b.y, o });
  }

  return (
    <g
      data-testid="closure-wave"
      data-front={spreadT.toFixed(3)}
      data-lit={segs.length}
      pointerEvents="none"
    >
      <defs>
        <filter id="closure-wave-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Soft wide under-glow + crisp bright core, both blue, riding the rail. */}
      <g filter="url(#closure-wave-glow)">
        {segs.map((s) => (
          <line
            key={`glow-${s.i}`}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke="#38bdf8"
            strokeWidth={9}
            strokeOpacity={s.o * 0.45}
            strokeLinecap="round"
          />
        ))}
        {segs.map((s) => (
          <line
            key={`core-${s.i}`}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke="#bae6fd"
            strokeWidth={3}
            strokeOpacity={s.o}
            strokeLinecap="round"
          />
        ))}
      </g>
    </g>
  );
}
