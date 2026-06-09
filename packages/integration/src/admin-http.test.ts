import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from '@trainframe/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const SIMPLE_LOOP: Layout = {
  name: 'simple-loop-admin',
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

let harness: Harness;
let admin: AdminHttpServer;
let baseUrl: string;

beforeEach(async () => {
  harness = await startHarness({ layout: SIMPLE_LOOP });
  admin = new AdminHttpServer({ server: harness.server });
  const port = await admin.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await admin.close();
  await harness.shutdown();
});

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Admin HTTP API', () => {
  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('POST /api/trains/:id/route assigns a route and the train receives grant_clearance on the wire', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    const res = await post('/api/trains/T1/route', {
      route_id: 'route-1',
      stops: ['M1', 'M3'],
    });
    expect(res.status).toBe(204);

    const grant = await harness.testClient.waitForCommand('T1', 'grant_clearance');
    expect((grant.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');
  });

  it('POST /api/gates/:id/hold publishes a hold_gate command on the wire', async () => {
    await harness.testClient.publishEvent('device_registered', 'GATE-1', {
      capabilities: ['core.gates_clearance'],
    });
    await harness.testClient.waitForState('railway/state/devices/GATE-1');

    const res = await post('/api/gates/GATE-1/hold', { marker_id: 'M3', reason: 'fault' });
    expect(res.status).toBe(204);

    const cmd = await harness.testClient.waitForCommand('GATE-1', 'hold_gate');
    expect((cmd.payload as { marker_id: string }).marker_id).toBe('M3');
    expect((cmd.payload as { reason: string }).reason).toBe('fault');
  });

  it('POST /api/tags binds a tag in the registry via the synthetic ADMIN-API device', async () => {
    const res = await post('/api/tags', {
      tag_id: 'TAG-NEW',
      assigned_kind: 'marker',
      target_id: 'M2',
    });
    expect(res.status).toBe(204);

    await harness.testClient.waitForState('railway/state/tags/TAG-NEW');
    const registry = harness.server.getScheduler().getTagRegistry();
    expect(registry.resolve('TAG-NEW')).toEqual({ kind: 'marker', target_id: 'M2' });
  });

  it('rejects payloads that don`t validate', async () => {
    const res = await post('/api/trains/T1/route', { route_id: 'r1' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/stops/);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it('POST /api/trains/:id/revoke_clearance frees the block for waiting peers', async () => {
    // Two trains contending for M1→M2. T1 wins the initial grant; T2 is
    // blocked. Operator revokes T1's clearance; T2 must then receive a grant
    // for the same edge, and T1's scheduler-side cleared_edges must be empty.
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.publishEvent('device_registered', 'T2', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    await harness.testClient.waitForState('railway/state/devices/T2');

    harness.server.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    await harness.testClient.waitForCommand('T1', 'grant_clearance');

    harness.server.assignSchedule('T2', 'route-2', ['M1', 'M2']);
    // T2 should not have a grant yet — T1 holds the block.
    const t2GrantsBefore = harness.testClient
      .commandsFor('T2')
      .filter((c) => c.command_type === 'grant_clearance');
    expect(t2GrantsBefore).toHaveLength(0);

    const res = await post('/api/trains/T1/revoke_clearance', {});
    expect(res.status).toBe(204);

    // Scheduler state should update immediately: T1 holds no edges,
    // T2 holds M1→M2 via the retried grant.
    const t1State = harness.server.getScheduler().getTrainState('T1');
    expect(t1State?.cleared_edges).toEqual([]);
    const t2State = harness.server.getScheduler().getTrainState('T2');
    expect(t2State?.cleared_edges).toEqual([{ from_marker_id: 'M1', to_marker_id: 'M2' }]);

    // T1 receives the revoke_clearance command on the wire.
    const revoke = await harness.testClient.waitForCommand('T1', 'revoke_clearance');
    expect(revoke.command_type).toBe('revoke_clearance');

    // T2 receives the previously-blocked grant_clearance.
    const t2Grant = await harness.testClient.waitForCommand('T2', 'grant_clearance');
    expect((t2Grant.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');
  });

  it('GET /api/state returns scheduler state (deprecated alias)', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    const res = await fetch(`${baseUrl}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trains: Array<{ train_id: string }> };
    expect(body.trains.find((t) => t.train_id === 'T1')).toBeDefined();
  });
});

describe('Query HTTP API (ADR-020)', () => {
  it('GET /api/query/layout projects the logical graph: markers and edges', async () => {
    const res = await fetch(`${baseUrl}/api/query/layout`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as {
      name: string;
      markers: Array<{ id: string; kind: string; switch_position?: string }>;
      edges: Array<{ from_marker_id: string; to_marker_id: string; inferred: boolean }>;
    };
    expect(body.name).toBe('simple-loop-admin');
    expect(body.markers.map((m) => m.id).sort()).toEqual(['M1', 'M2', 'M3', 'M4']);
    expect(body.markers.find((m) => m.id === 'M3')?.kind).toBe('station_stop');
    expect(body.edges).toContainEqual({
      from_marker_id: 'M1',
      to_marker_id: 'M2',
      inferred: false,
    });
    // No spatial coordinates leak into the logical projection (ADR-013).
    for (const m of body.markers) {
      expect(m).not.toHaveProperty('position');
    }
  });

  it('GET /api/query/traversal-times lists every edge with a sample count', async () => {
    const res = await fetch(`${baseUrl}/api/query/traversal-times`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edges: Array<{
        from_marker_id: string;
        to_marker_id: string;
        samples: number;
        learned_ms?: number;
      }>;
    };
    expect(body.edges).toHaveLength(4);
    // Untraversed edges still appear, with zero samples and no learned estimate.
    const m1m2 = body.edges.find((e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2');
    expect(m1m2?.samples).toBe(0);
    expect(m1m2?.learned_ms).toBeUndefined();
  });

  it('GET /api/query/traversal-times?train_id= echoes the train scope', async () => {
    const res = await fetch(`${baseUrl}/api/query/traversal-times?train_id=T7`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { train_id?: string; edges: unknown[] };
    expect(body.train_id).toBe('T7');
    expect(body.edges).toHaveLength(4);
  });

  it('GET /api/query/traversal-times surfaces a learned estimate once an edge is run', async () => {
    await harness.testClient.seedIdentityTags(['M1', 'M2', 'M3']);
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    /*
     * Drive the train across M1→M2→M3 via tag observations. The scheduler
     * records each traversal with a real-clock timestamp; from the second
     * recorded traversal onward the EWMA has a delta to learn from, so M2→M3
     * gains a learned estimate while every traversed edge gains a sample count.
     */
    const cross = (id: string) =>
      harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: id });
    await cross('M1');
    await cross('M2');
    await cross('M3');

    await expect
      .poll(
        async () => {
          const res = await fetch(`${baseUrl}/api/query/traversal-times`);
          const body = (await res.json()) as {
            edges: Array<{
              from_marker_id: string;
              to_marker_id: string;
              samples: number;
              learned_ms?: number;
            }>;
          };
          const learned = body.edges.find(
            (e) => e.from_marker_id === 'M2' && e.to_marker_id === 'M3',
          );
          return (
            learned !== undefined && learned.samples >= 1 && typeof learned.learned_ms === 'number'
          );
        },
        { timeout: 2_000 },
      )
      .toBe(true);
  });

  it('GET /api/query/trains lists all train states', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    harness.server.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    await harness.testClient.waitForCommand('T1', 'grant_clearance');

    const res = await fetch(`${baseUrl}/api/query/trains`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trains: Array<{ train_id: string; cleared_edges: unknown[] }>;
    };
    const t1 = body.trains.find((t) => t.train_id === 'T1');
    expect(t1).toBeDefined();
    expect(t1?.cleared_edges).toContainEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
  });

  it('GET /api/query/trains/:id returns one train, 404 for unknown', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    const ok = await fetch(`${baseUrl}/api/query/trains/T1`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { train_id: string };
    expect(body.train_id).toBe('T1');

    const missing = await fetch(`${baseUrl}/api/query/trains/NOPE`);
    expect(missing.status).toBe(404);
    const err = (await missing.json()) as { error: string; code: string };
    expect(err.code).toBe('not_found');
  });

  it('GET /api/query/clearances reports who holds what', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    harness.server.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    await harness.testClient.waitForCommand('T1', 'grant_clearance');

    const res = await fetch(`${baseUrl}/api/query/clearances`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clearances: Array<{
        train_id: string;
        cleared_edges: Array<{ from_marker_id: string; to_marker_id: string }>;
        clearance_limit_marker_id?: string;
      }>;
    };
    const t1 = body.clearances.find((c) => c.train_id === 'T1');
    expect(t1?.cleared_edges).toContainEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(t1?.clearance_limit_marker_id).toBeDefined();
  });

  it('GET /api/query/layout reports the live switch position for junctions', async () => {
    const junctionLayout: Layout = {
      name: 'junction-layout',
      markers: [
        { id: 'M1', kind: 'block_boundary' },
        { id: 'J1', kind: 'junction' },
        { id: 'M2', kind: 'block_boundary' },
        { id: 'M3', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'J1', estimated_length_mm: 200 },
        {
          from_marker_id: 'J1',
          to_marker_id: 'M2',
          requires_switch_state: 'main',
          estimated_length_mm: 200,
        },
        {
          from_marker_id: 'J1',
          to_marker_id: 'M3',
          requires_switch_state: 'diverge',
          estimated_length_mm: 200,
        },
      ],
      junctions: [{ marker_id: 'J1', initial_state: 'main' }],
    };
    const jHarness = await startHarness({ layout: junctionLayout });
    const jAdmin = new AdminHttpServer({ server: jHarness.server });
    const jPort = await jAdmin.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${jPort}/api/query/layout`);
      const body = (await res.json()) as {
        markers: Array<{ id: string; kind: string; switch_position?: string }>;
        edges: Array<{
          from_marker_id: string;
          to_marker_id: string;
          requires_switch_state?: string;
        }>;
      };
      expect(body.markers.find((m) => m.id === 'J1')?.switch_position).toBe('main');
      expect(body.markers.find((m) => m.id === 'M1')?.switch_position).toBeUndefined();
      const diverge = body.edges.find((e) => e.from_marker_id === 'J1' && e.to_marker_id === 'M3');
      expect(diverge?.requires_switch_state).toBe('diverge');
    } finally {
      await jAdmin.close();
      await jHarness.shutdown();
    }
  });

  it('GET /api/query/tags returns current tag bindings', async () => {
    await post('/api/tags', { tag_id: 'TAG-Q', assigned_kind: 'marker', target_id: 'M2' });
    await harness.testClient.waitForState('railway/state/tags/TAG-Q');

    const res = await fetch(`${baseUrl}/api/query/tags`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tags: Array<{ tag_id: string; kind: string; target_id: string }>;
    };
    expect(body.tags).toContainEqual({ tag_id: 'TAG-Q', kind: 'marker', target_id: 'M2' });
  });
});
