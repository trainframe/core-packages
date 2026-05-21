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
    register_tags: 'identity',
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

describe('SimRunner — layout state', () => {
  it('publishes the active layout as a retained state message on start', () => {
    const { runner, client } = makeRunner();
    runner.start();

    const layoutMsg = client.published.find((m) => m.topic === 'railway/state/layout/simple-loop');
    expect(layoutMsg).toBeDefined();
    if (!layoutMsg) throw new Error('unreachable');

    const decoded = JSON.parse(new TextDecoder().decode(layoutMsg.payload));
    expect(decoded.name).toBe('simple-loop');
    expect(decoded.markers).toHaveLength(SIMPLE_LOOP.markers.length);
  });

  it('replays the retained layout to a subscriber that joined after start', () => {
    const { runner, client } = makeRunner();
    runner.start();

    const seen: string[] = [];
    client.subscribe('railway/state/layout/+', (msg) => {
      seen.push(msg.topic);
    });

    expect(seen).toEqual(['railway/state/layout/simple-loop']);
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

function makeDeviceOnlyRunner(): { runner: SimRunner; client: InMemoryBrokerClient } {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test');
  const runner = new SimRunner(client, {
    layout: SIMPLE_LOOP,
    tick_ms: 100,
    newId: () => FIXED_ID,
    mode: 'device-only',
    register_tags: 'identity',
  });
  return { runner, client };
}

describe('SimRunner — device-only mode', () => {
  it('still publishes device events from spawned trains', () => {
    const { runner, client } = makeDeviceOnlyRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });

    const registered = client.published.find(
      (m) => m.topic === 'railway/events/device_registered/T1',
    );
    expect(registered).toBeDefined();
  });

  it('does not publish server-derived events (no embedded scheduler runs)', () => {
    const { runner, client } = makeDeviceOnlyRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    runner.step(5_000);

    const fromServer = client.published.filter((m) => m.topic.endsWith('/server'));
    expect(fromServer).toHaveLength(0);
  });

  it('routes inbound commands from the broker into the simulation', () => {
    const { runner, client } = makeDeviceOnlyRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });

    client.publish(
      'railway/commands/T1',
      new TextEncoder().encode(
        JSON.stringify({
          command_id: 'c1',
          device_id: 'T1',
          command_type: 'assign_route',
          payload: {
            route_id: 'r-1',
            edges: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
          },
        }),
      ),
    );
    client.publish(
      'railway/commands/T1',
      new TextEncoder().encode(
        JSON.stringify({
          command_id: 'c2',
          device_id: 'T1',
          command_type: 'grant_clearance',
          payload: {
            limit_marker_id: 'M2',
            edges_newly_cleared: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
          },
        }),
      ),
    );

    // Train should now move and emit a tag_observed at M2 within a few ticks.
    runner.step(5_000);
    const tagEvents = client.published.filter((m) =>
      m.topic.startsWith('railway/events/tag_observed/'),
    );
    expect(tagEvents.length).toBeGreaterThan(0);
  });

  it('throws if assignRoute is called locally - server must drive routing', () => {
    const { runner } = makeDeviceOnlyRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(() => runner.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }])).toThrow(
      /device-only mode/,
    );
  });

  it('publishes the layout state as retained on start, same as embedded mode', () => {
    const { runner, client } = makeDeviceOnlyRunner();
    runner.start();
    const layoutMsg = client.published.find((m) => m.topic === 'railway/state/layout/simple-loop');
    expect(layoutMsg).toBeDefined();
  });
});
