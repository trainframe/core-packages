import { describe, expect, it } from 'vitest';
import { countBridges } from '../track/overlap.js';
import { buildMainLoopScene } from './interesting-layout.js';
import type { RailNetwork } from './network.js';
import { PhysicsWorld } from './world.js';

interface Pt {
  x: number;
  y: number;
}
interface SampledSeg {
  id: string;
  pts: Pt[];
  ends: [Pt, Pt];
}

/** Sample every segment's rail into a polyline + its two endpoints. */
function sampleSegments(net: RailNetwork): SampledSeg[] {
  return net.segments().map((id) => {
    const r = net.railOf(id);
    const pts: Pt[] = [];
    const n = Math.max(4, Math.ceil(r.length / 8));
    for (let i = 0; i <= n; i++) pts.push(r.at((r.length * i) / n));
    return { id, pts, ends: [r.at(0), r.at(r.length)] };
  });
}

/** Whether two sampled segments are JOINED (share an endpoint — adjacent on the loop). */
function joined(a: SampledSeg, b: SampledSeg): boolean {
  for (const ea of a.ends)
    for (const eb of b.ends) if (Math.hypot(ea.x - eb.x, ea.y - eb.y) < 30) return true;
  return false;
}

/** Minimum sampled distance between two polylines. */
function minDist(a: SampledSeg, b: SampledSeg): number {
  let min = Number.POSITIVE_INFINITY;
  for (const pa of a.pts)
    for (const pb of b.pts) min = Math.min(min, Math.hypot(pa.x - pb.x, pa.y - pb.y));
  return min;
}

/** The closest DISTINCT (non-joined) segment pair across the layout. */
function closestDistinctPair(net: RailNetwork): { gap: number; where: string } {
  const segs = sampleSegments(net);
  let gap = Number.POSITIVE_INFINITY;
  let where = '';
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (b === undefined || joined(a, b)) continue;
      const d = minDist(a, b);
      if (d < gap) {
        gap = d;
        where = `${a.id} ~ ${b.id}`;
      }
    }
  }
  return { gap, where };
}

describe('interesting-layout — main loop with branch taps', () => {
  it('builds overlap-clean and closes', () => {
    const scene = buildMainLoopScene();
    expect(scene.closureGapMm).toBeLessThan(2);
  });

  it('crosses over itself exactly once, on a bridge (the crossover loop)', () => {
    const scene = buildMainLoopScene();
    expect(countBridges(scene.pieces)).toBe(1);
  });

  it('has no near-misses: distinct runs stay well clear of each other (no flat overlaps)', () => {
    /* The tightest distinct pair must stay clear — a flat overlap (two runs within a
     *  rail-width) would foul. Turnout throats sit ~65mm apart; a true overlap is <20mm. */
    const { gap, where } = closestDistinctPair(buildMainLoopScene().net);
    expect(gap, `closest distinct runs: ${where} (${gap.toFixed(0)}mm)`).toBeGreaterThan(40);
  });

  it('exposes three branch taps (yard + two satellites)', () => {
    const { branches } = buildMainLoopScene();
    expect(branches.yard.switchId).toBe('yard-DIV');
    expect(branches.satA.switchId).toBe('satA-SW');
    expect(branches.satB.switchId).toBe('satB-SW');
  });

  it('a train laps the main loop on the through route without leaving the rails', () => {
    const scene = buildMainLoopScene();
    const world = new PhysicsWorld(scene.net);
    /* Every tap on `main` so the train stays on the running loop. */
    world.setSwitch(scene.branches.yard.switchId, scene.branches.yard.mainPos);
    world.setSwitch(scene.branches.satA.switchId, scene.branches.satA.mainPos);
    world.setSwitch(scene.branches.satB.switchId, scene.branches.satB.mainPos);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: scene.startSegment,
      color: 'red',
      motion: 'forward',
      maxSpeed: 240,
    });
    const start = world.bodies()[0];
    if (start === undefined) throw new Error('no body');
    const startPt = { x: start.x, y: start.y };
    let maxDist = 0;
    let lapped = false;
    let leftRails = false;
    const DT = 1 / 60;
    for (let i = 0; i < 60 * 120; i++) {
      world.step(DT);
      const b = world.bodies()[0];
      if (b === undefined) continue;
      if (b.fate !== 'on-rail' || b.mode !== 'railed') leftRails = true;
      const d = Math.hypot(b.x - startPt.x, b.y - startPt.y);
      maxDist = Math.max(maxDist, d);
      if (maxDist > 600 && d < 60) lapped = true;
    }
    expect(leftRails).toBe(false);
    expect(lapped).toBe(true);
  });
});
