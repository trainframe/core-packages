/**
 * Headless tunnel demo (ADR-030 sensing-only). Proves the three load-bearing
 * facts the scenario rests on:
 *   1. a body keeps moving NORMALLY through the covered region — it emerges past
 *      the far portal on-rail (the roof is cosmetic, body motion is unaffected);
 *   2. a DARK tunnel blinds the in-tunnel camera (`cameraSawInside` stays false)
 *      while the entry + exit MARKER tripwires both still fire (tracked through);
 *   3. a LIT tunnel does NOT occlude — the same camera sees the train inside
 *      (`cameraSawInside` true) — so occlusion is a per-tunnel property.
 */
import { describe, expect, it } from 'vitest';
import { TunnelRun } from './tunnel-run.js';
import { makeTunnel } from './tunnel.js';

const STEP_S = 1 / 120;

function makeRun(lighting: 'dark' | 'lit'): TunnelRun {
  return new TunnelRun({
    railX0: 150,
    railX1: 2050,
    railY: 600,
    startRailPos: 200,
    tunnel: makeTunnel({ id: 't', x0: 900, x1: 1350, y: 600, halfWidth: 60, lighting }),
  });
}

function locoX(run: TunnelRun): number {
  const t = run
    .physicsWorld()
    .bodies()
    .find((b) => b.id === 'T');
  if (t === undefined) throw new Error('no loco');
  return t.x;
}

/** Run for `seconds` of fixed steps. */
function advance(run: TunnelRun, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / STEP_S); i++) run.step(STEP_S);
}

describe('TunnelRun — a roofed stretch of ordinary track', () => {
  it('a body keeps moving normally through the covered region and emerges on-rail', () => {
    const run = makeRun('dark');
    const startX = locoX(run);
    expect(startX).toBeLessThan(900); // starts before the near portal
    advance(run, 18);
    const t = run
      .physicsWorld()
      .bodies()
      .find((b) => b.id === 'T');
    expect(t?.fate).toBe('on-rail');
    expect(t?.mode).toBe('railed');
    expect(locoX(run)).toBeGreaterThan(1450); // emerged well past the far portal
  });

  it('a DARK tunnel keeps the camera blind while the portal markers still fire', () => {
    const run = makeRun('dark');
    advance(run, 18);
    expect(run.firedMarkers()).toEqual(['entry', 'exit']); // tracked through the dark
    expect(run.cameraSawInside()).toBe(false); // camera never saw inside
  });

  it('a LIT tunnel lets the same camera see the train inside (per-tunnel occlusion)', () => {
    const run = makeRun('lit');
    advance(run, 18);
    expect(run.firedMarkers()).toEqual(['entry', 'exit']);
    expect(run.cameraSawInside()).toBe(true);
  });
});
