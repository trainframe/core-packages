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
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
      ],
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
    expect(body.error).toMatch(/edges/);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it('GET /api/state returns scheduler state', async () => {
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
