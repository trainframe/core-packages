import { describe, expect, it, vi } from 'vitest';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import { SIMPLE_LOOP } from './layouts.js';
import { SimRunner } from './sim-runner.js';

const FIXED_ID = '00000000-0000-4000-8000-000000000000';

function makeRunner(): { runner: SimRunner; client: InMemoryBrokerClient } {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test');
  const runner = new SimRunner(client, {
    layout: SIMPLE_LOOP,
    tick_ms: 100,
    newId: () => FIXED_ID,
  });
  return { runner, client };
}

function decode(payload: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(payload));
}

describe('SimRunner — lifecycle', () => {
  it('reports idle before start, paused after start, running after resume', () => {
    const { runner } = makeRunner();
    expect(runner.snapshot().status).toBe('idle');

    runner.start();
    expect(runner.snapshot().status).toBe('paused');

    runner.resume();
    expect(runner.snapshot().status).toBe('running');

    runner.pause();
    expect(runner.snapshot().status).toBe('paused');

    runner.stop();
    expect(runner.snapshot().status).toBe('idle');
  });

  it('start is idempotent', () => {
    const { runner } = makeRunner();
    runner.start();
    const first = runner.snapshot().sim_time_ms;
    runner.start();
    expect(runner.snapshot().sim_time_ms).toBe(first);
  });

  it('notifies snapshot listeners on lifecycle changes', () => {
    const { runner } = makeRunner();
    const seen: string[] = [];
    runner.onSnapshotChange((s) => seen.push(s.status));

    runner.start();
    runner.resume();
    runner.pause();
    runner.stop();

    expect(seen).toEqual(['idle', 'paused', 'running', 'paused', 'idle']);
  });
});

describe('SimRunner — event publishing', () => {
  it('publishes a device_registered envelope to the broker when a train is spawned', () => {
    const { runner, client } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });

    const registered = client.published.find(
      (m) => m.topic === 'railway/events/device_registered/T1',
    );
    expect(registered).toBeDefined();
    if (!registered) throw new Error('unreachable');
    const envelope = decode(registered.payload) as {
      event_id: string;
      device_id: string;
      event_type: string;
      protocol_version: string;
      payload: { capabilities: string[] };
    };
    expect(envelope.event_id).toBe(FIXED_ID);
    expect(envelope.device_id).toBe('T1');
    expect(envelope.event_type).toBe('device_registered');
    expect(envelope.protocol_version).toBe('0.2.0');
    expect(envelope.payload.capabilities).toContain('core.controls_motion');
  });

  it('publishes server-derived marker_traversed events with device_id="server"', () => {
    const { runner, client } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    runner.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    runner.step(5_000);

    const marker = client.published.find(
      (m) => m.topic === 'railway/events/marker_traversed/server',
    );
    expect(marker).toBeDefined();
  });

  it('counts published events in its snapshot', () => {
    const { runner } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(runner.snapshot().events_published).toBeGreaterThan(0);
  });

  it('exposes the registered trains in its snapshot', () => {
    const { runner } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(runner.snapshot().train_ids).toEqual(['T1']);

    // Idempotent on duplicate spawn.
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(runner.snapshot().train_ids).toEqual(['T1']);
  });
});

describe('SimRunner — auto-advance', () => {
  it('advances the sim on the configured interval when resumed', () => {
    vi.useFakeTimers();
    try {
      const { runner } = makeRunner();
      runner.start();
      runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
      runner.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);

      const before = runner.snapshot().sim_time_ms;
      runner.resume();
      vi.advanceTimersByTime(500);
      const after = runner.snapshot().sim_time_ms;

      expect(after).toBeGreaterThan(before);
      runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
