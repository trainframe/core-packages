import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { InMemoryBrokerClient } from './broker/in-memory-client.js';
import { Server } from './server.js';

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

const FIXED_ID = '00000000-0000-4000-8000-000000000000';

function makeServer(): { server: Server; client: InMemoryBrokerClient } {
  const client = new InMemoryBrokerClient();
  const server = new Server({ layout: SIMPLE_LOOP, client, newId: () => FIXED_ID });
  server.start();
  return { server, client };
}

function publishWireEvent(
  client: InMemoryBrokerClient,
  event_type: string,
  device_id: string,
  payload: unknown,
): void {
  const envelope = {
    event_id: `event-${device_id}`,
    device_id,
    timestamp_device: '2026-05-06T12:00:00Z',
    event_type,
    protocol_version: '0.2.0',
    payload,
  };
  client.publish(
    `railway/events/${event_type}/${device_id}`,
    new TextEncoder().encode(JSON.stringify(envelope)),
  );
}

function decode<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}

describe('Server — startup', () => {
  it('publishes the active layout retained on start', () => {
    const { client } = makeServer();
    const layoutMsg = client.published.find((m) => m.topic === 'railway/state/layout/simple-loop');
    expect(layoutMsg).toBeDefined();
    if (!layoutMsg) throw new Error('unreachable');
    expect(decode<Layout>(layoutMsg.payload).name).toBe('simple-loop');
  });
});

describe('Server — registers a train and grants its initial clearance', () => {
  it('publishes a grant_clearance command after assignRoute', () => {
    const { server, client } = makeServer();

    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });

    server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    const commands = client.published.filter((m) => m.topic === 'railway/commands/T1');
    const grant = commands
      .map((m) =>
        decode<{ command_type: string; payload: { limit_marker_id?: string } }>(m.payload),
      )
      .find((env) => env.command_type === 'grant_clearance');
    expect(grant).toBeDefined();
    if (!grant) throw new Error('unreachable');
    expect(grant.payload.limit_marker_id).toBe('M2');
  });
});

describe('Server — gate clearance flow', () => {
  it('does not grant past a withheld marker, and grants once the gate releases', () => {
    const { server, client } = makeServer();

    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishWireEvent(client, 'device_registered', 'GATE-M3', {
      capabilities: ['core.gates_clearance'],
    });
    publishWireEvent(client, 'device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    for (const marker of ['M1', 'M2', 'M3', 'M4']) {
      publishWireEvent(client, 'tag_assignment', 'GARAGE', {
        tag_id: marker,
        assigned_kind: 'marker',
        target_id: marker,
      });
    }
    publishWireEvent(client, 'gate_state_changed', 'GATE-M3', {
      marker_id: 'M3',
      state: 'withholding',
      reason: 'crane busy',
    });

    server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    const beforeRelease = countCommands(client, 'T1', 'grant_clearance');
    expect(beforeRelease).toBe(1); // initial M2 grant

    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M1' });
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M2' });

    expect(countCommands(client, 'T1', 'grant_clearance')).toBe(1); // still gated at M3

    publishWireEvent(client, 'gate_state_changed', 'GATE-M3', {
      marker_id: 'M3',
      state: 'granting',
    });

    expect(countCommands(client, 'T1', 'grant_clearance')).toBe(2); // gate released, M3 granted
  });
});

describe('Server — defensive parsing', () => {
  it('drops messages with malformed JSON', () => {
    const { server, client } = makeServer();
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    client.publish('railway/events/tag_observed/T1', new TextEncoder().encode('not-json-at-all'));
    expect(() => server.assignRoute('T1', 'r', [])).not.toThrow();
  });

  it('ignores its own server-emitted events to avoid feedback loops', () => {
    const { client } = makeServer();
    const before = client.published.length;
    publishWireEvent(client, 'anomaly', 'server', { severity: 'info', description: 'self' });
    // No new effects beyond the original publish itself; nothing fanned out.
    expect(client.published.length).toBe(before + 1);
  });

  it('drops messages on non-event topics that happen to slip into the subscription', () => {
    // The pattern railway/events/+/+ is exact-segment; this just verifies a
    // ridiculous topic with extra segments doesn't crash.
    const { client } = makeServer();
    client.publish('railway/events/foo/bar/extra', new TextEncoder().encode('{}'));
  });
});

function countCommands(
  client: InMemoryBrokerClient,
  train_id: string,
  command_type: string,
): number {
  return client.published.filter((m) => {
    if (m.topic !== `railway/commands/${train_id}`) return false;
    try {
      const envelope = decode<{ command_type: string }>(m.payload);
      return envelope.command_type === command_type;
    } catch {
      return false;
    }
  }).length;
}
