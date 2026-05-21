import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { FAULT_PROFILES, startTestEnvironment } from './testing.js';

const SIMPLE_LOOP: Layout = {
  name: 'simple-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
    { id: 'M4', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

describe('startTestEnvironment', () => {
  it('runs a route to completion under the pristine fault profile', () => {
    const env = startTestEnvironment({ layout: SIMPLE_LOOP, seed: 1, faults: 'pristine' });
    env.simulation.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    env.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    const reachedM3 = env.waitForEvent({
      event_type: 'marker_traversed',
      matching: { train_id: 'T1', marker_id: 'M3' },
      timeoutMs: 10_000,
    });
    expect(reachedM3).toBeDefined();
    env.shutdown();
  });

  it('hostile profile produces visibly more anomalies than pristine over the same trip', () => {
    const run = (faults: 'pristine' | 'hostile') => {
      const env = startTestEnvironment({ layout: SIMPLE_LOOP, seed: 1, faults });
      env.simulation.spawnTrain('T1', {
        startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      });
      env.assignRoute('T1', [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
        { from_marker_id: 'M3', to_marker_id: 'M4' },
        { from_marker_id: 'M4', to_marker_id: 'M1' },
      ]);
      env.advance(20_000);
      const traversals = env.getEventsOfType('marker_traversed').length;
      env.shutdown();
      return traversals;
    };

    // Hostile drops markers (10% miss). It still moves but reports fewer
    // traversals across the same wall budget. We only assert ordering -
    // exact counts depend on the seed.
    const pristineCount = run('pristine');
    const hostileCount = run('hostile');
    expect(pristineCount).toBeGreaterThanOrEqual(hostileCount);
  });

  it('per-train config overrides win against the active fault profile', () => {
    const env = startTestEnvironment({ layout: SIMPLE_LOOP, seed: 1, faults: 'hostile' });
    env.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      // Force this train onto pristine physics inside a hostile environment.
      config: FAULT_PROFILES.pristine,
    });
    env.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    const reached = env.waitForEvent({
      event_type: 'marker_traversed',
      matching: { train_id: 'T1', marker_id: 'M3' },
    });
    expect(reached).toBeDefined();
  });

  it('exposes FAULT_PROFILES as a public lookup for one-off composition', () => {
    expect(FAULT_PROFILES.pristine.miss_rate).toBe(0);
    expect(FAULT_PROFILES.hostile.miss_rate).toBeGreaterThan(0);
  });

  it('with tags: "none" the harness leaves the registry empty', () => {
    const env = startTestEnvironment({
      layout: SIMPLE_LOOP,
      seed: 1,
      faults: 'pristine',
      tags: 'none',
    });
    expect(env.simulation.scheduler?.getTagRegistry().entries()).toHaveLength(0);
  });

  it('waitForEvent throws when the budget is exhausted', () => {
    const env = startTestEnvironment({ layout: SIMPLE_LOOP, seed: 1, faults: 'pristine' });
    expect(() =>
      env.waitForEvent({
        event_type: 'this_event_type_never_occurs',
        timeoutMs: 200,
      }),
    ).toThrow(/timed out/);
  });
});
