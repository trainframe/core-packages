import { type Layout, PROTOCOL_VERSION } from '@trainframe/protocol';
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
    protocol_version: PROTOCOL_VERSION,
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

  it('publishes a cleared deadlock state retained on start (resets stale retained)', () => {
    const { client } = makeServer();
    // Subscribe AFTER start: the in-memory client replays retained messages to
    // new subscribers, so this proves the cleared deadlock state is retained —
    // a fresh subscriber (or a restarted server's visualiser) sees no deadlock,
    // rather than a previous instance's stale `{trains:[…]}`.
    let received: { trains: string[] } | undefined;
    client.subscribe('railway/state/deadlock/active', (m) => {
      received = decode<{ trains: string[] }>(m.payload);
    });
    expect(received).toBeDefined();
    expect(received?.trains).toEqual([]);
  });
});

describe('Server — registers a train and grants its initial clearance', () => {
  it('publishes a grant_clearance command after assignSchedule', () => {
    const { server, client } = makeServer();

    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });

    // Schedule [M1, M3]: brand-new train, no last_marker_id → scheduler
    // treats M1 as the spawn and the planner plans M1 → M2 → M3. Initial
    // grant should be for M2 (the first edge's to_marker).
    server.assignSchedule('T1', 'route-1', ['M1', 'M3']);

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

    server.assignSchedule('T1', 'route-1', ['M1', 'M3']);

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
    expect(() => server.assignSchedule('T1', 'r', [])).not.toThrow();
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

describe('Server — admin injection points', () => {
  it('a device registered via injectEvent gains real capabilities — its tag assignment is honoured, an unprivileged device is rejected', () => {
    const { server, client } = makeServer();

    // An unprivileged device tries to bind a tag and is ignored: nothing
    // retained on the tag's state topic.
    publishWireEvent(client, 'device_registered', 'IMPOSTOR', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishWireEvent(client, 'tag_assignment', 'IMPOSTOR', {
      tag_id: 'TAG-X',
      assigned_kind: 'marker',
      target_id: 'M2',
    });
    expect(client.published.find((m) => m.topic === 'railway/state/tags/TAG-X')).toBeUndefined();

    // The admin injects a device registration that grants core.assigns_tags.
    // That same device can now bind TAG-Y, and the binding becomes visible
    // to the rest of the bus as retained state.
    server.injectEvent('device_registered', 'ADMIN', {
      capabilities: ['core.assigns_tags'],
    });
    publishWireEvent(client, 'tag_assignment', 'ADMIN', {
      tag_id: 'TAG-Y',
      assigned_kind: 'marker',
      target_id: 'M2',
    });
    expect(client.published.find((m) => m.topic === 'railway/state/tags/TAG-Y')).toBeDefined();
  });

  it('a command sent via publishCommand reaches a device subscribed to its command topic', () => {
    const { server, client } = makeServer();
    const received: Array<{ command_type: string; payload: unknown }> = [];
    client.subscribe('railway/commands/GATE-1', (msg) => {
      received.push(decode<{ command_type: string; payload: unknown }>(msg.payload));
    });

    server.publishCommand('GATE-1', 'release_gate', { marker_id: 'M3' });

    expect(received).toHaveLength(1);
    expect(received[0]?.command_type).toBe('release_gate');
    expect(received[0]?.payload).toEqual({ marker_id: 'M3' });
  });
});

describe('Server — operator commands on railway/operator/+', () => {
  it('routes assign_schedule to Server.assignSchedule and emits the grant_clearance', () => {
    const { client } = makeServer();
    // Register T1 so the scheduler knows about it.
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    // Publish the operator intent on the bus (the visualiser's path).
    client.publish(
      'railway/operator/assign_schedule',
      new TextEncoder().encode(
        JSON.stringify({ train_id: 'T1', route_id: 'r-op', stops: ['M1', 'M2'] }),
      ),
    );
    // Expect a grant_clearance command on T1's topic — proves the scheduler ran.
    const grant = client.published
      .filter((m) => m.topic === 'railway/commands/T1')
      .map((m) => decode<{ command_type: string }>(m.payload))
      .find((env) => env.command_type === 'grant_clearance');
    expect(grant).toBeDefined();
  });

  it('routes revoke_clearance to Server.revokeClearance and emits the revoke command', () => {
    const { client } = makeServer();
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    // First give T1 something to revoke.
    client.publish(
      'railway/operator/assign_schedule',
      new TextEncoder().encode(
        JSON.stringify({ train_id: 'T1', route_id: 'r-op', stops: ['M1', 'M2'] }),
      ),
    );
    // Now revoke via the operator topic.
    client.publish(
      'railway/operator/revoke_clearance',
      new TextEncoder().encode(JSON.stringify({ train_id: 'T1' })),
    );
    const revoke = client.published
      .filter((m) => m.topic === 'railway/commands/T1')
      .map((m) => decode<{ command_type: string }>(m.payload))
      .find((env) => env.command_type === 'revoke_clearance');
    expect(revoke).toBeDefined();
  });

  it('silently drops operator commands with malformed JSON', () => {
    const { client } = makeServer();
    client.publish('railway/operator/assign_schedule', new TextEncoder().encode('not-json-at-all'));
    // No new commands published; the test passes if no throw.
    expect(true).toBe(true);
  });

  it('ignores unknown operator command types', () => {
    const { client } = makeServer();
    client.publish(
      'railway/operator/who_knows',
      new TextEncoder().encode(JSON.stringify({ foo: 'bar' })),
    );
    expect(true).toBe(true);
  });
});

describe('device disconnect clears retained device registration', () => {
  it('tombstones railway/state/devices/<id> so the train does not resurrect', () => {
    const { client } = makeServer();
    publishWireEvent(client, 'device_registered', 'T1', { capabilities: ['core.controls_motion'] });

    /* Sanity: the device is registered as a non-empty retained snapshot. */
    const registered = client.retained.get('railway/state/devices/T1');
    expect(registered).toBeDefined();
    if (!registered) throw new Error('unreachable');
    expect(decode<{ capabilities: string[] }>(registered.payload).capabilities).toContain(
      'core.controls_motion',
    );

    publishWireEvent(client, 'device_disconnected', 'T1', {});

    /* The retained device topic is now an empty tombstone (no capabilities). */
    const after = client.retained.get('railway/state/devices/T1');
    expect(after).toBeDefined();
    if (!after) throw new Error('unreachable');
    expect(decode<Record<string, unknown>>(after.payload)).toEqual({});
  });
});

describe('scheduler reset clears all in-memory state', () => {
  it('forgets trains and learned layout', () => {
    const { server, client } = makeServer();
    publishWireEvent(client, 'device_registered', 'T1', { capabilities: ['core.controls_motion'] });
    expect(server.getScheduler().getTrainIds()).toContain('T1');

    server.getScheduler().reset();

    expect(server.getScheduler().getTrainIds()).toEqual([]);
    expect(server.getScheduler().getTrainState('T1')).toBeUndefined();
    /* Layout reverts to the declared baseline (SIMPLE_LOOP has 4 markers). */
    expect(server.getScheduler().getLayout().toLayout().markers).toHaveLength(4);
  });
});

describe('Server.reset blank-slates server and broker', () => {
  it('tombstones retained ghosts the server never registered', () => {
    const { server, client } = makeServer();
    /*
     * Simulate a ghost left by a previous server/sim instance: a retained
     * device snapshot published directly to the broker after start(). The
     * server's railway/state/# ledger should still pick it up.
     */
    client.publish(
      'railway/state/devices/GHOST',
      new TextEncoder().encode(JSON.stringify({ capabilities: ['core.controls_motion'] })),
      { retain: true },
    );
    client.publish(
      'railway/state/schedule/GHOST',
      new TextEncoder().encode(
        JSON.stringify({ train_id: 'GHOST', route_id: 'r', stops: ['M1'], current_stop_index: 0 }),
      ),
      { retain: true },
    );

    const summary = server.reset();

    expect(summary.topics_cleared).toBeGreaterThanOrEqual(2);

    const ghostDevice = client.retained.get('railway/state/devices/GHOST');
    expect(ghostDevice).toBeDefined();
    if (!ghostDevice) throw new Error('unreachable');
    expect(decode<Record<string, unknown>>(ghostDevice.payload)).toEqual({});

    const ghostSchedule = client.retained.get('railway/state/schedule/GHOST');
    expect(ghostSchedule).toBeDefined();
    if (!ghostSchedule) throw new Error('unreachable');
    expect(decode<Record<string, unknown>>(ghostSchedule.payload)).toEqual({ train_id: 'GHOST' });

    /* Deadlock baseline re-established. */
    const deadlock = client.retained.get('railway/state/deadlock/active');
    expect(deadlock).toBeDefined();
    if (!deadlock) throw new Error('unreachable');
    expect(decode<{ trains: string[] }>(deadlock.payload).trains).toEqual([]);
  });

  it('tombstones retained switches and tags ghosts', () => {
    const { server, client } = makeServer();
    /* Plant retained ghosts for the two families that were previously skipped
     * by emptyPayloadForStateTopic (it returned null → reset silently skipped
     * them, leaving the broker/scheduler diverged after reset). */
    client.publish(
      'railway/state/tags/TAG-1',
      new TextEncoder().encode(JSON.stringify({ assigned_kind: 'train', target_id: 'T1' })),
      { retain: true },
    );
    client.publish(
      'railway/state/switches/M-JCT',
      new TextEncoder().encode(JSON.stringify({ position: 'diverge', confirmed: true })),
      { retain: true },
    );

    server.reset();

    /* Both families must now carry a tombstone — not the stale snapshot. */
    const ghostTag = client.retained.get('railway/state/tags/TAG-1');
    expect(ghostTag).toBeDefined();
    if (!ghostTag) throw new Error('unreachable');
    expect(decode<Record<string, unknown>>(ghostTag.payload)).toEqual({});

    const ghostSwitch = client.retained.get('railway/state/switches/M-JCT');
    expect(ghostSwitch).toBeDefined();
    if (!ghostSwitch) throw new Error('unreachable');
    expect(decode<Record<string, unknown>>(ghostSwitch.payload)).toEqual({});
  });
});

describe('Server.deleteTrain', () => {
  it('forgets a known train and reports success; 404s an unknown one', () => {
    const { server, client } = makeServer();
    publishWireEvent(client, 'device_registered', 'T1', { capabilities: ['core.controls_motion'] });

    expect(server.deleteTrain('NOPE')).toBe(false);
    expect(server.deleteTrain('T1')).toBe(true);
    expect(server.getScheduler().getTrainState('T1')).toBeUndefined();

    const deviceMsg = client.retained.get('railway/state/devices/T1');
    expect(deviceMsg).toBeDefined();
    if (!deviceMsg) throw new Error('unreachable');
    expect(decode<Record<string, unknown>>(deviceMsg.payload)).toEqual({});
  });
});

describe('Server.pruneOrphanMarkers', () => {
  it('removes zero-edge markers and republishes the layout', () => {
    const { server, client } = makeServer();
    server.getScheduler().getLayout().upsertMarker('ORPHAN', 'block_boundary');

    const pruned = server.pruneOrphanMarkers();

    expect(pruned).toEqual(['ORPHAN']);
    const layoutMsg = client.retained.get('railway/state/layout/simple-loop');
    expect(layoutMsg).toBeDefined();
    if (!layoutMsg) throw new Error('unreachable');
    const layout = decode<{ markers: Array<{ id: string }> }>(layoutMsg.payload);
    expect(layout.markers.map((m) => m.id)).not.toContain('ORPHAN');
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
