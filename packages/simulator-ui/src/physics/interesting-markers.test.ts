import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { buildMainLoopScene } from './interesting-layout.js';
import {
  INTERESTING_MARKERS,
  buildInterestingMarkers,
  interestingToLayout,
} from './interesting-markers.js';
import { PhysicsWorld } from './world.js';

/* Demo marker ids aren't uuids; validate STRUCTURE only (matches the railyard). */
FormatRegistry.Set('uuid', () => true);

const M = INTERESTING_MARKERS;

describe('interesting-markers — sparse markers + station→station routing', () => {
  it('compiles to a schema-valid protocol Layout', () => {
    const layout = interestingToLayout(buildMainLoopScene());
    expect(Value.Check(Layout, layout)).toBe(true);
  });

  it('places a station on EACH satellite loop + running-line stations', () => {
    const { markers } = buildInterestingMarkers(buildMainLoopScene());
    const stations = markers.filter((m) => m.kind === 'station_stop').map((m) => m.id);
    expect(stations).toContain(M.satAStation);
    expect(stations).toContain(M.satBStation);
    expect(stations).toContain(M.north);
  });

  it('declares the satellites + yard as junctions', () => {
    const { junctions } = buildInterestingMarkers(buildMainLoopScene());
    expect(junctions.map((j) => j.markerId).sort()).toEqual([M.satA, M.satB, M.yardJn].sort());
  });

  it('routes different trains to different satellite stations (only some visit each)', () => {
    const { routes } = buildInterestingMarkers(buildMainLoopScene());
    const express = routes.find((r) => r.trainId === 'T-express');
    const local = routes.find((r) => r.trainId === 'T-local');
    expect(express?.stops).toContain(M.satAStation);
    expect(express?.stops).not.toContain(M.satBStation);
    expect(local?.stops).toContain(M.satBStation);
    expect(local?.stops).not.toContain(M.satAStation);
  });

  it('forms a connected running cycle reachable from north', () => {
    const { edges } = buildInterestingMarkers(buildMainLoopScene());
    const seen = new Set<string>([M.north]);
    const q: string[] = [M.north];
    while (q.length) {
      const h = q.shift();
      if (h === undefined) continue;
      for (const e of edges) {
        if (e.from === h && !seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
      }
    }
    /* Both satellite stations + the yard are reachable from north. */
    for (const id of [M.satAStation, M.satBStation, M.south, M.yard])
      expect(seen.has(id)).toBe(true);
    expect(edges.some((e) => e.to === M.north)).toBe(true); // loops back
  });

  it('every running-line marker lies on the lapping path (logical graph matches physics)', () => {
    const scene = buildMainLoopScene();
    const { markers } = buildInterestingMarkers(scene);
    const pts = markers.map((m) => {
      const r = scene.net.railOf(m.segment);
      const d = m.distAlongMm ?? (m.end === 'start' ? 0 : r.length);
      const p = r.at(d);
      return { id: m.id, x: p.x, y: p.y };
    });
    /* A train lapping the running line (every junction on `main`). */
    const w = new PhysicsWorld(scene.net);
    w.setSwitch(scene.branches.yard.switchId, scene.branches.yard.mainPos);
    w.setSwitch(scene.branches.satA.switchId, scene.branches.satA.mainPos);
    w.setSwitch(scene.branches.satB.switchId, scene.branches.satB.mainPos);
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: scene.startSegment,
      motion: 'forward',
      maxSpeed: 240,
    });
    const minDist = new Map(pts.map((p) => [p.id, Number.POSITIVE_INFINITY]));
    for (let i = 0; i < 60 * 120; i++) {
      w.step(1 / 60);
      const b = w.bodies()[0];
      if (b === undefined) break;
      for (const p of pts) {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < (minDist.get(p.id) ?? Number.POSITIVE_INFINITY)) minDist.set(p.id, d);
      }
    }
    /* Every RUNNING-LINE marker must be passed close (the satellite STATIONS sit off
     *  the main, so a main-only lap skips them — not asserted here). */
    for (const id of [M.north, M.satA, M.satB, M.yardJn, M.south])
      expect(minDist.get(id), `${id} closest approach (mm)`).toBeLessThan(40);
  });
});
