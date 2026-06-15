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
    expect(junctions.map((j) => j.markerId).sort()).toEqual([M.satA, M.satB, M.yard].sort());
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
});
