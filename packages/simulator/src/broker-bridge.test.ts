import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BrokerBridge, type BrokerLike } from './broker-bridge.js';
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

/**
 * Tiny in-process broker stand-in. Honours topic equality and the single-
 * level `#` wildcard. Enough to exercise the bridge without pulling aedes
 * into the simulator package's deps; full broker behaviour is covered by
 * `@trainframe/integration` against aedes.
 */
class FakeBroker implements BrokerLike {
  readonly published: Array<{ topic: string; payload: Uint8Array }> = [];
  private readonly subs: Array<{
    pattern: string;
    handler: (m: { topic: string; payload: Uint8Array }) => void;
  }> = [];

  subscribe(
    pattern: string,
    handler: (m: { topic: string; payload: Uint8Array }) => void,
  ): () => void {
    const entry = { pattern, handler };
    this.subs.push(entry);
    return () => {
      const idx = this.subs.indexOf(entry);
      if (idx >= 0) this.subs.splice(idx, 1);
    };
  }

  publish(topic: string, payload: Uint8Array): void {
    this.published.push({ topic, payload });
    for (const sub of this.subs) {
      if (matches(sub.pattern, topic)) sub.handler({ topic, payload });
    }
  }

  /** Test-side helper: feed a command into the broker as if a server published it. */
  inject(topic: string, payload: object): void {
    this.publish(topic, new TextEncoder().encode(JSON.stringify(payload)));
  }
}

function matches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern.endsWith('/#')) {
    const prefix = pattern.slice(0, -1);
    return topic.startsWith(prefix);
  }
  return false;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('BrokerBridge', () => {
  it('a subscriber on the bus sees a newly-spawned virtual train identify itself and advertise what it can do', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, disableScheduler: true });
    const broker = new FakeBroker();
    const bridge = new BrokerBridge(sim, broker, { newId: () => 'id-x' });
    bridge.start();

    // A consumer subscribes to events for T1 before the train exists.
    const seen: Array<{ event_type: string; capabilities?: string[] }> = [];
    broker.subscribe('railway/events/#', (m) => {
      const env = JSON.parse(decode(m.payload)) as {
        device_id: string;
        event_type: string;
        payload: { capabilities?: string[] };
      };
      if (env.device_id !== 'T1') return;
      seen.push({
        event_type: env.event_type,
        ...(env.payload.capabilities ? { capabilities: env.payload.capabilities } : {}),
      });
    });

    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });

    const registration = seen.find((e) => e.event_type === 'device_registered');
    expect(registration).toBeDefined();
    expect(registration?.capabilities).toContain('core.controls_motion');
  });

  it('a command published on the bus reaches the virtual train and makes it move', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, disableScheduler: true });
    const broker = new FakeBroker();
    const bridge = new BrokerBridge(sim, broker, { newId: () => 'id-x' });
    bridge.start();

    const train = sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });
    expect(train.getVelocity()).toBe(0); // starts stopped

    // A server on the bus assigns a route and grants clearance — exactly as
    // a real server would.
    broker.inject('railway/commands/T1', {
      command_id: 'c1',
      device_id: 'T1',
      command_type: 'assign_route',
      payload: {
        route_id: 'r-1',
        edges: [
          { from_marker_id: 'M1', to_marker_id: 'M2' },
          { from_marker_id: 'M2', to_marker_id: 'M3' },
        ],
      },
    });
    broker.inject('railway/commands/T1', {
      command_id: 'c2',
      device_id: 'T1',
      command_type: 'grant_clearance',
      payload: {
        limit_marker_id: 'M2',
        edges_newly_cleared: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
      },
    });

    sim.advance(2_000);
    expect(train.getVelocity()).toBeGreaterThan(0);
    expect(train.getDistanceIntoEdge()).toBeGreaterThan(0);
  });

  it('ignores malformed command messages without throwing', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, disableScheduler: true });
    const broker = new FakeBroker();
    const bridge = new BrokerBridge(sim, broker, { newId: () => 'id-x' });
    bridge.start();

    broker.publish('railway/commands/T1', new TextEncoder().encode('not json'));
    broker.inject('railway/commands/T1', { command_id: 'c1' }); // no command_type
    broker.publish('railway/commands/', new TextEncoder().encode('{}')); // empty device

    expect(sim.commands).toHaveLength(0);
  });

  it('stop() unsubscribes both directions', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, disableScheduler: true });
    const broker = new FakeBroker();
    const bridge = new BrokerBridge(sim, broker, { newId: () => 'id-x' });
    bridge.start();
    bridge.stop();

    const publishedBefore = broker.published.length;
    sim.spawnTrain('T2', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    expect(broker.published).toHaveLength(publishedBefore);

    broker.inject('railway/commands/T2', {
      command_id: 'c1',
      device_id: 'T2',
      command_type: 'emergency_stop',
      payload: {},
    });
    expect(sim.commands).toHaveLength(0);
  });
});

describe('Simulation device-only mode', () => {
  it('throws if assignRoute is called without the embedded scheduler', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, disableScheduler: true });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    expect(() => sim.assignRoute('T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }])).toThrow(
      /embedded scheduler disabled/,
    );
  });

  it('handleCommand applies assign_route + grant_clearance to a virtual train', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1, disableScheduler: true });
    const train = sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r-1',
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', {
      limit_marker_id: 'M2',
      edges_newly_cleared: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
    });
    sim.advance(2000);
    expect(train.getDistanceIntoEdge()).toBeGreaterThan(0);
    expect(train.getVelocity()).toBeGreaterThan(0);
  });
});
