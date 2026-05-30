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
  it('the operator can spawn a train, watch it move, pause it, and clear the world', () => {
    const { runner, client } = makeRunner();

    // Nothing has happened yet: no trains exposed, no events on the broker.
    expect(runner.snapshot().train_ids).toEqual([]);
    expect(client.published).toHaveLength(0);

    // Spawning surfaces the train in the snapshot and on the broker.
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    runner.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    expect(runner.snapshot().train_ids).toEqual(['T1']);

    // Resuming auto-advances the sim clock; pausing stops it.
    runner.resume();
    const movingTime = runner.snapshot().sim_time_ms;
    runner.pause();
    const pausedTime = runner.snapshot().sim_time_ms;
    // Pause holds the clock steady (within one tick of where it stopped).
    expect(pausedTime).toBeGreaterThanOrEqual(movingTime);

    // Stop wipes the world back to empty.
    runner.stop();
    expect(runner.snapshot().train_ids).toEqual([]);
    expect(runner.snapshot().sim_time_ms).toBe(0);
  });

  it('calling start twice does not reset an already-running sim', () => {
    const { runner } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    runner.step(1_000);
    const firstTime = runner.snapshot().sim_time_ms;
    const firstTrains = runner.snapshot().train_ids;

    runner.start();
    expect(runner.snapshot().sim_time_ms).toBe(firstTime);
    expect(runner.snapshot().train_ids).toEqual(firstTrains);
  });

  it('snapshot listeners are notified whenever observable state changes', () => {
    const { runner } = makeRunner();
    const snapshots: Array<{ trains: number; events: number }> = [];
    runner.onSnapshotChange((s) =>
      snapshots.push({ trains: s.train_ids.length, events: s.events_published }),
    );

    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    runner.stop();

    // We don't pin an exact sequence — the contract is just that observable
    // changes produce notifications. Start with no trains, peak at one, end
    // back at zero.
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(snapshots[0]?.trains).toBe(0);
    expect(Math.max(...snapshots.map((s) => s.trains))).toBe(1);
    expect(snapshots[snapshots.length - 1]?.trains).toBe(0);
  });
});

describe('SimRunner — event publishing', () => {
  it('a spawned train shows up on the broker as a registered device the rest of the bus can see', () => {
    const { runner, client } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });

    const registration = client.published
      .map((m) => ({ topic: m.topic, payload: decode(m.payload) }))
      .find(
        (m): m is { topic: string; payload: { device_id: string; event_type: string } } =>
          typeof (m.payload as { event_type?: unknown }).event_type === 'string' &&
          (m.payload as { event_type: string }).event_type === 'device_registered' &&
          (m.payload as { device_id?: unknown }).device_id === 'T1',
      );
    expect(registration).toBeDefined();
    if (!registration) throw new Error('unreachable');
    // A consumer of the bus sees enough to act: the train identifies itself
    // and lists what it can do.
    const payload = registration.payload as unknown as {
      payload: { capabilities: string[] };
    };
    expect(payload.payload.capabilities).toContain('core.controls_motion');
  });

  it('stepping after spawn produces marker traversal events for the train as it moves', () => {
    const { runner, client } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    runner.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    runner.step(5_000);

    const traversals = client.published.filter((m) =>
      m.topic.startsWith('railway/events/marker_traversed/'),
    );
    expect(traversals.length).toBeGreaterThan(0);
  });

  it('the events_published counter grows as the operator steps the sim', () => {
    const { runner } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    runner.assignRoute('T1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    const afterSpawn = runner.snapshot().events_published;
    expect(afterSpawn).toBeGreaterThan(0);

    runner.step(5_000);
    expect(runner.snapshot().events_published).toBeGreaterThan(afterSpawn);
  });

  it('the snapshot reports the trains the operator has spawned, without duplicates', () => {
    const { runner } = makeRunner();
    runner.start();
    runner.spawnTrain('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(runner.snapshot().train_ids).toEqual(['T1']);

    // Spawning the same id twice is a no-op from the operator's POV.
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
