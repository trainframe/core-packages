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
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
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
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
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

  it('a train on a short edge still advances when the next-edge grant arrives', () => {
    // Layout where the first edge is shorter than the previously-hardcoded
    // 200mm transition threshold. Discovered live: SHORT_LOOP edges of 100mm
    // left the train parked at M2 because the grant_clearance handler
    // checked `distance_into_edge_mm >= 200` instead of the real edge length.
    const SHORT_LOOP: Layout = {
      name: 'short-loop',
      markers: [
        { id: 'M1', kind: 'block_boundary' },
        { id: 'M2', kind: 'block_boundary' },
        { id: 'M3', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 100 },
        { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 100 },
      ],
      junctions: [],
    };
    const sim = new Simulation({ layout: SHORT_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    sim.advance(10_000);

    const traversals = sim
      .getEventsOfType('marker_traversed')
      .map((t) => (t.payload as { marker_id: string }).marker_id);
    expect(traversals).toEqual(['M2', 'M3']);
  });

  it('two trains on the same route do not occupy the same edge', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 2, register_tags: 'identity' });
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

describe('physical mishaps — overshoot', () => {
  it('emits an anomaly event when overshoot_rate forces a brake to fail', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      config: { overshoot_rate: 1, stopping_noise: 0 },
    });
    sim.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
    sim.advance(10_000);

    const anomalies = sim
      .getEventsOfType('anomaly')
      .filter((e) => e.device_id === 'T1')
      .map((e) => (e.payload as { description: string }).description);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0]).toMatch(/T1 overshot clearance limit at M2/);
  });

  it('does not emit an overshoot anomaly with overshoot_rate at 0', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      config: { overshoot_rate: 0 },
    });
    sim.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
    sim.advance(10_000);

    const overshootAnomalies = sim.getEventsOfType('anomaly').filter((e) => e.device_id === 'T1');
    expect(overshootAnomalies).toEqual([]);
  });
});

describe('event listener hook', () => {
  it('streams every captured event to subscribers in order', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 7, register_tags: 'identity' });
    const seen: Array<{ event_type: string; device_id: string }> = [];
    const off = sim.onEvent((e) => seen.push({ event_type: e.event_type, device_id: e.device_id }));

    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
    sim.advance(5_000);

    expect(seen[0]).toEqual({ event_type: 'device_registered', device_id: 'T1' });
    expect(seen.some((e) => e.event_type === 'tag_observed' && e.device_id === 'T1')).toBe(true);
    expect(seen.some((e) => e.event_type === 'marker_traversed' && e.device_id === 'server')).toBe(
      true,
    );

    off();
    const before = seen.length;
    sim.advance(1_000);
    expect(seen.length).toBe(before);
  });
});

describe('detection mishaps — double reads', () => {
  it('emits two tag_observed events for a single marker crossing when double_read_rate is 1', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      // miss_rate: 0 so the primary read is guaranteed to arrive
      config: { double_read_rate: 1, miss_rate: 0 },
    });
    sim.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
    sim.advance(10_000);

    const tagEvents = sim
      .getEventsOfType('tag_observed')
      .filter((e) => e.device_id === 'T1' && (e.payload as { tag_id: string }).tag_id === 'M2');
    expect(tagEvents.length).toBe(2);
    // The second read must arrive strictly after the first.
    const first = tagEvents[0];
    const second = tagEvents[1];
    if (!first || !second) throw new Error('unreachable');
    expect(second.at_ms).toBeGreaterThan(first.at_ms);
  });
});

describe('detection mishaps — spurious reads', () => {
  it('emits tag_observed events with a spurious- prefix after a few ticks when spurious_read_rate is 1', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      config: { spurious_read_rate: 1 },
    });
    // No route needed — spurious reads fire every tick regardless.
    sim.advance(200); // 4 ticks at 50 ms default

    const spurious = sim
      .getEventsOfType('tag_observed')
      .filter(
        (e) =>
          e.device_id === 'T1' && (e.payload as { tag_id: string }).tag_id.startsWith('spurious-'),
      );
    expect(spurious.length).toBeGreaterThanOrEqual(4);
  });
});

describe('determinism', () => {
  it('produces identical outputs with the same seed', () => {
    const run = (seed: number) => {
      const sim = new Simulation({ layout: SIMPLE_LOOP, seed, register_tags: 'identity' });
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

describe('train_status emission', () => {
  it('emits train_status events at the configured interval with edge + distance + speed', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      config: { train_status_interval_ms: 100 },
    });
    sim.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    sim.advance(1_000); // 10 status windows

    const statuses = sim.getEventsOfType('train_status');
    expect(statuses.length).toBeGreaterThanOrEqual(8);
    const first = statuses[0]?.payload as {
      train_id: string;
      current_edge?: { from_marker_id: string; to_marker_id: string };
      speed_normalised: number;
    };
    expect(first.train_id).toBe('T1');
    expect(first.current_edge?.from_marker_id).toBe('M1');
    expect(first.speed_normalised).toBeGreaterThanOrEqual(0);
    expect(first.speed_normalised).toBeLessThanOrEqual(1);
  });

  it('does not emit train_status when interval is 0', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      config: { train_status_interval_ms: 0 },
    });
    sim.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
    sim.advance(2_000);
    expect(sim.getEventsOfType('train_status')).toHaveLength(0);
  });
});

describe('despawn → device_disconnected', () => {
  it('despawnGate emits a device_disconnected event and the scheduler releases the gate`s withholds', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    const gate = sim.spawnGate('GATE-M3');
    gate.withhold('M3', 'crane busy');

    sim.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
      { from_marker_id: 'M3', to_marker_id: 'M4' },
    ]);
    sim.advance(10_000);

    // Train is stopped at M2.
    expect(
      sim
        .getEventsOfType('marker_traversed')
        .map((e) => (e.payload as { marker_id: string }).marker_id),
    ).toEqual(['M2']);
    expect(sim.getTrain('T1')?.getVelocity()).toBe(0);

    // Gate vanishes.
    sim.despawnGate('GATE-M3');

    expect(sim.getEventsOfType('device_disconnected')).toHaveLength(1);
    expect(sim.getEventsOfType('device_disconnected')[0]?.device_id).toBe('GATE-M3');

    // Train resumes after the disconnect-triggered re-grant.
    sim.advance(10_000);
    const traversals = sim
      .getEventsOfType('marker_traversed')
      .map((e) => (e.payload as { marker_id: string }).marker_id);
    expect(traversals).toContain('M3');
  });

  it('despawnTrain emits a device_disconnected event and frees its held block for a waiting peer', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.spawnTrain('T2', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });

    sim.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
    sim.assignRoute('T2', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);

    // T2 was blocked by T1.
    const t2GrantsBefore = sim
      .getCommandsForDevice('T2')
      .filter((c) => c.event_type === 'grant_clearance');
    expect(t2GrantsBefore).toHaveLength(0);

    // T1 vanishes (e.g. derailed and unplugged).
    sim.despawnTrain('T1');

    expect(sim.getEventsOfType('device_disconnected')).toHaveLength(1);
    expect(sim.getEventsOfType('device_disconnected')[0]?.device_id).toBe('T1');

    const t2Grants = sim
      .getCommandsForDevice('T2')
      .filter((c) => c.event_type === 'grant_clearance');
    expect(t2Grants).toHaveLength(1);
    expect((t2Grants[0]?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');
  });

  it('despawning an unknown train or gate is a no-op', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, register_tags: 'identity' });
    sim.despawnTrain('NEVER-SPAWNED');
    sim.despawnGate('NEVER-SPAWNED');
    expect(sim.getEventsOfType('device_disconnected')).toHaveLength(0);
  });
});
