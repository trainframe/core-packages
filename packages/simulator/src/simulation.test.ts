import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';

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

describe('end-to-end: virtual train obeys clearances', () => {
  it('a train assigned a route moves through markers in order', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });

    sim.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
      { from_marker_id: 'M3', to_marker_id: 'M4' },
    ]);

    // Run for 10 simulated seconds.
    sim.advance(10_000);

    const traversals = sim.getEventsOfType('marker_traversed');
    const markerOrder = traversals.map((t) => (t.payload as { marker_id: string }).marker_id);
    expect(markerOrder).toEqual(['M2', 'M3', 'M4']);
  });

  it('a gated marker stops the train, releasing the gate lets it continue', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    const gate = sim.spawnGate('GATE-M3');
    gate.withhold('M3', 'crane busy');

    sim.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
      { from_marker_id: 'M3', to_marker_id: 'M4' },
    ]);

    sim.advance(10_000);

    // Train should have reached M2 but not M3.
    const traversals = sim
      .getEventsOfType('marker_traversed')
      .map((t) => (t.payload as { marker_id: string }).marker_id);
    expect(traversals).toEqual(['M2']);

    const train = sim.getTrain('T1');
    expect(train?.getVelocity()).toBe(0);

    // Release the gate.
    gate.release('M3');
    sim.advance(10_000);

    const traversalsAfter = sim
      .getEventsOfType('marker_traversed')
      .map((t) => (t.payload as { marker_id: string }).marker_id);
    expect(traversalsAfter).toEqual(['M2', 'M3', 'M4']);
  });

  it('two trains on the same route do not occupy the same edge', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 2 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.spawnTrain('T2', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });

    sim.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    sim.assignRoute('T2', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    sim.advance(10_000);

    // T1 has clearance and moves; T2 was denied initial clearance and shouldn't move.
    const t1 = sim.getTrain('T1');
    const t2 = sim.getTrain('T2');
    expect(t1?.getDistanceIntoEdge()).toBeGreaterThan(0);
    expect(t2?.getVelocity()).toBe(0);
  });
});

describe('determinism', () => {
  it('produces identical outputs with the same seed', () => {
    const run = (seed: number) => {
      const sim = new Simulation({ layout: SIMPLE_LOOP, seed });
      sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
      sim.assignRoute('T1', [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
      ]);
      sim.advance(5_000);
      return sim.getEventsOfType('marker_traversed').map((e) => ({
        at_ms: e.at_ms,
        marker_id: (e.payload as { marker_id: string }).marker_id,
      }));
    };

    expect(run(99)).toEqual(run(99));
  });
});
