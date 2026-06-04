import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { InMemoryBrokerClient } from './broker/in-memory-client.js';
import { Server } from './server.js';

/**
 * Track-learn mode tests. Drive the real Server through the in-memory broker
 * so the LearnMode code path goes through the exact same event-handling chain
 * as production. No mocks; assert on what's published on the wire.
 */

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

const TERMINUS_LAYOUT: Layout = {
  name: 'with-terminus',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'terminus' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
  ],
  junctions: [],
};

const JUNCTION_LAYOUT: Layout = {
  name: 'junction-layout',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'JCT', kind: 'junction' },
    { id: 'MAIN', kind: 'block_boundary' },
    { id: 'DIV', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'JCT', estimated_length_mm: 200 },
    { from_marker_id: 'JCT', to_marker_id: 'MAIN', requires_switch_state: 'main' },
    { from_marker_id: 'JCT', to_marker_id: 'DIV', requires_switch_state: 'divert' },
  ],
  junctions: [{ marker_id: 'JCT', initial_state: 'main' }],
};

const FIXED_ID = '00000000-0000-4000-8000-000000000000';

function makeServer(layout: Layout): { server: Server; client: InMemoryBrokerClient } {
  const client = new InMemoryBrokerClient();
  const server = new Server({ layout, client, newId: () => FIXED_ID });
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

function publishOperatorCommand(
  client: InMemoryBrokerClient,
  commandType: string,
  payload: unknown,
): void {
  client.publish(
    `railway/operator/${commandType}`,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
}

function decode<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}

function latestLearnState(client: InMemoryBrokerClient): {
  state: string;
  train_id?: string;
  markers_visited?: number;
  edges_learned?: number;
  start_marker_id?: string;
  last_marker_id?: string;
} | null {
  const msgs = client.published.filter((m) => m.topic === 'railway/state/track_learning/active');
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  return decode(last.payload);
}

function commandsFor(
  client: InMemoryBrokerClient,
  device_id: string,
  command_type: string,
): Array<{
  command_type: string;
  payload: { route_id?: string; edges?: unknown; limit_marker_id?: string; position?: string };
}> {
  return client.published
    .filter((m) => m.topic === `railway/commands/${device_id}`)
    .map((m) =>
      decode<{
        command_type: string;
        payload: {
          route_id?: string;
          edges?: unknown;
          limit_marker_id?: string;
          position?: string;
        };
      }>(m.payload),
    )
    .filter((env) => env.command_type === command_type);
}

describe('LearnMode — initial retained state', () => {
  it('publishes idle to railway/state/track_learning/active on start', () => {
    const { client } = makeServer(SIMPLE_LOOP);
    const snapshot = latestLearnState(client);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.state).toBe('idle');
  });
});

describe('LearnMode — learn_track_start with no registered train', () => {
  it('moves to waiting_for_train', () => {
    const { client } = makeServer(SIMPLE_LOOP);
    publishOperatorCommand(client, 'learn_track_start', {});
    expect(latestLearnState(client)?.state).toBe('waiting_for_train');
  });
});

describe('LearnMode — drives a registered train', () => {
  it('once the train reports its first marker, issues set_switch (if needed) then assign_route + grant_clearance', () => {
    const { client } = makeServer(SIMPLE_LOOP);
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishWireEvent(client, 'device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    for (const m of ['M1', 'M2', 'M3', 'M4']) {
      publishWireEvent(client, 'tag_assignment', 'GARAGE', {
        tag_id: m,
        assigned_kind: 'marker',
        target_id: m,
      });
    }
    publishOperatorCommand(client, 'learn_track_start', {});

    // T1 has been registered but hasn't yet scanned a marker — LearnMode
    // sits in waiting_for_train with T1 latched as the target.
    expect(latestLearnState(client)?.state).toBe('waiting_for_train');
    expect(latestLearnState(client)?.train_id).toBe('T1');

    // The train scans M1: scheduler updates last_marker; LearnMode then
    // transitions to driving and chooses M1's only outgoing edge (M1→M2).
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M1' });

    const routes = commandsFor(client, 'T1', 'assign_route');
    expect(routes.length).toBeGreaterThanOrEqual(1);
    const first = routes[0];
    if (!first) throw new Error('expected at least one assign_route');
    expect(first.payload.edges).toEqual([{ from_marker_id: 'M1', to_marker_id: 'M2' }]);

    const grants = commandsFor(client, 'T1', 'grant_clearance');
    const lastGrant = grants[grants.length - 1];
    if (!lastGrant) throw new Error('expected a grant_clearance');
    expect(lastGrant.payload.limit_marker_id).toBe('M2');
    expect(latestLearnState(client)?.markers_visited).toBe(1);
  });
});

describe('LearnMode — traversals advance to the next edge', () => {
  it('emits a new assign_route on each marker the train hits', () => {
    const { client } = makeServer(SIMPLE_LOOP);
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishWireEvent(client, 'device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    for (const m of ['M1', 'M2', 'M3', 'M4']) {
      publishWireEvent(client, 'tag_assignment', 'GARAGE', {
        tag_id: m,
        assigned_kind: 'marker',
        target_id: m,
      });
    }
    publishOperatorCommand(client, 'learn_track_start', {});
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M1' });
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M2' });

    const routes = commandsFor(client, 'T1', 'assign_route');
    // Two assign_route commands at least: M1→M2, then M2→M3.
    expect(routes.length).toBeGreaterThanOrEqual(2);
    const second = routes[1];
    if (!second) throw new Error('expected a second assign_route');
    expect(second.payload.edges).toEqual([{ from_marker_id: 'M2', to_marker_id: 'M3' }]);

    const state = latestLearnState(client);
    expect(state?.markers_visited).toBe(2);
    expect(state?.edges_learned).toBe(1); // we traversed M1→M2
  });
});

describe('LearnMode — completes after a full loop', () => {
  it('transitions to complete when the train returns to its start marker with no unexplored edges', () => {
    const { client } = makeServer(SIMPLE_LOOP);
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishWireEvent(client, 'device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    for (const m of ['M1', 'M2', 'M3', 'M4']) {
      publishWireEvent(client, 'tag_assignment', 'GARAGE', {
        tag_id: m,
        assigned_kind: 'marker',
        target_id: m,
      });
    }
    publishOperatorCommand(client, 'learn_track_start', {});
    for (const m of ['M1', 'M2', 'M3', 'M4', 'M1']) {
      publishWireEvent(client, 'tag_observed', 'T1', { tag_id: m });
    }
    expect(latestLearnState(client)?.state).toBe('complete');
  });
});

describe('LearnMode — hits a terminus and pauses', () => {
  it('transitions to paused_terminus and stops issuing commands', () => {
    const { client } = makeServer(TERMINUS_LAYOUT);
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishWireEvent(client, 'device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    for (const m of ['M1', 'M2', 'M3']) {
      publishWireEvent(client, 'tag_assignment', 'GARAGE', {
        tag_id: m,
        assigned_kind: 'marker',
        target_id: m,
      });
    }
    publishOperatorCommand(client, 'learn_track_start', {});
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M1' });
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M2' });
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M3' });

    expect(latestLearnState(client)?.state).toBe('paused_terminus');

    // No further assign_route should be issued after pause (i.e. count is
    // exactly the two we expected: M1→M2, M2→M3).
    const routesBefore = commandsFor(client, 'T1', 'assign_route').length;
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M3' });
    const routesAfter = commandsFor(client, 'T1', 'assign_route').length;
    expect(routesAfter).toBe(routesBefore);
  });
});

describe('LearnMode — learn_track_stop returns to idle', () => {
  it('clears local state and publishes idle', () => {
    const { client } = makeServer(SIMPLE_LOOP);
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishOperatorCommand(client, 'learn_track_start', {});
    publishOperatorCommand(client, 'learn_track_stop', {});
    expect(latestLearnState(client)?.state).toBe('idle');
  });
});

describe('LearnMode — junction routing', () => {
  it('issues set_switch_position to the switch device (not the marker) before assign_route', () => {
    const { client } = makeServer(JUNCTION_LAYOUT);
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishWireEvent(client, 'device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    for (const m of ['M1', 'JCT', 'MAIN', 'DIV']) {
      publishWireEvent(client, 'tag_assignment', 'GARAGE', {
        tag_id: m,
        assigned_kind: 'marker',
        target_id: m,
      });
    }
    // Register the switch motor for the junction with controls_marker_id so
    // the server records the pairing and LearnMode can resolve JCT → SWITCH-JCT.
    publishWireEvent(client, 'device_registered', 'SWITCH-JCT', {
      capabilities: ['core.controls_switch'],
      controls_marker_id: 'JCT',
    });
    publishOperatorCommand(client, 'learn_track_start', {});
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'M1' });
    publishWireEvent(client, 'tag_observed', 'T1', { tag_id: 'JCT' });

    // After reaching JCT, LearnMode chose one of the outgoing edges
    // ({main, divert}). Whatever it chose, if the switch wasn't already at
    // that position it should emit set_switch_position to SWITCH-JCT (the
    // device), not to JCT (the marker).
    const routes = commandsFor(client, 'T1', 'assign_route');
    const lastRoute = routes[routes.length - 1];
    if (!lastRoute) throw new Error('expected a route from JCT');
    const edges = lastRoute.payload.edges as ReadonlyArray<{ to_marker_id: string }>;
    const chosenTo = edges[0]?.to_marker_id;
    expect(chosenTo === 'MAIN' || chosenTo === 'DIV').toBe(true);

    if (chosenTo === 'DIV') {
      // The initial switch state is 'main' — LearnMode must have asked
      // SWITCH-JCT (the device) to flip to 'divert' first.
      const switches = commandsFor(client, 'SWITCH-JCT', 'set_switch_position');
      expect(switches.length).toBeGreaterThanOrEqual(1);
      const last = switches[switches.length - 1];
      expect(last?.payload.position).toBe('divert');
    }

    // Confirm no commands were addressed to the marker id directly.
    const wrongTarget = commandsFor(client, 'JCT', 'set_switch_position');
    expect(wrongTarget).toHaveLength(0);
  });
});

describe('LearnMode — start named train', () => {
  it('drives the specifically requested train when train_id is supplied', () => {
    const { client } = makeServer(SIMPLE_LOOP);
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishWireEvent(client, 'device_registered', 'T2', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    publishOperatorCommand(client, 'learn_track_start', { train_id: 'T2' });
    expect(latestLearnState(client)?.train_id).toBe('T2');
  });
});

describe('LearnMode — observability hook', () => {
  it('getLearnMode returns the active train id while learning', () => {
    const { server, client } = makeServer(SIMPLE_LOOP);
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    expect(server.getLearnMode().isActive()).toBe(false);
    publishOperatorCommand(client, 'learn_track_start', {});
    expect(server.getLearnMode().isActive()).toBe(true);
    expect(server.getLearnMode().activeTrainId()).toBe('T1');
    publishOperatorCommand(client, 'learn_track_stop', {});
    expect(server.getLearnMode().isActive()).toBe(false);
  });
});
