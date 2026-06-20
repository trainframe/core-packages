import { type Layout, PROTOCOL_VERSION } from '@trainframe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminHttpServer } from './admin-http.js';
import { InMemoryBrokerClient } from './broker/in-memory-client.js';
import { Server } from './server.js';

/*
 * Integration tests for the AdminHttpServer HTTP API. Each test starts a real
 * HTTP listener on an OS-assigned port (0) and drives it with real fetch calls
 * against 127.0.0.1. No mocking — the Server and its scheduler run for real.
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

const FIXED_ID = '00000000-0000-4000-8000-000000000000';

function publishWireEvent(
  client: InMemoryBrokerClient,
  event_type: string,
  device_id: string,
  payload: unknown,
): void {
  const envelope = {
    event_id: `event-${device_id}`,
    device_id,
    timestamp_device: '2026-06-20T12:00:00Z',
    event_type,
    protocol_version: PROTOCOL_VERSION,
    payload,
  };
  client.publish(
    `railway/events/${event_type}/${device_id}`,
    new TextEncoder().encode(JSON.stringify(envelope)),
  );
}

interface TestHarness {
  server: Server;
  client: InMemoryBrokerClient;
  adminHttp: AdminHttpServer;
  baseUrl: string;
}

async function makeHarness(): Promise<TestHarness> {
  const client = new InMemoryBrokerClient();
  const server = new Server({ layout: SIMPLE_LOOP, client, newId: () => FIXED_ID });
  server.start();
  const adminHttp = new AdminHttpServer({ server, adminDeviceId: 'ADMIN-TEST' });
  const port = await adminHttp.listen(0);
  return { server, client, adminHttp, baseUrl: `http://127.0.0.1:${port}` };
}

describe('AdminHttpServer — DELETE /api/trains/:id', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.adminHttp.close();
  });

  it('forgets a known train and returns 200 {deleted}', async () => {
    const { client, baseUrl } = harness;
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion'],
    });

    const res = await fetch(`${baseUrl}/api/trains/T1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 'T1' });
  });

  it('returns 404 for an unknown train', async () => {
    const { baseUrl } = harness;

    const res = await fetch(`${baseUrl}/api/trains/NOPE`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('not_found');
  });

  it('decodes percent-encoded train ids', async () => {
    const { client, baseUrl } = harness;
    publishWireEvent(client, 'device_registered', 'T 1', {
      capabilities: ['core.controls_motion'],
    });

    const res = await fetch(`${baseUrl}/api/trains/${encodeURIComponent('T 1')}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 'T 1' });
  });
});

describe('AdminHttpServer — POST /api/maintenance/prune-markers', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.adminHttp.close();
  });

  it('returns 200 with pruned ids when orphan markers exist', async () => {
    const { server, baseUrl } = harness;
    /* Insert a marker with no edges — the definition of orphan. */
    server.getScheduler().getLayout().upsertMarker('ORPHAN', 'block_boundary');

    const res = await fetch(`${baseUrl}/api/maintenance/prune-markers`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pruned: string[] };
    expect(body.pruned).toContain('ORPHAN');
  });

  it('returns 200 with empty pruned array when no orphans exist', async () => {
    const { baseUrl } = harness;

    const res = await fetch(`${baseUrl}/api/maintenance/prune-markers`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pruned: string[] };
    expect(body.pruned).toEqual([]);
  });
});

describe('AdminHttpServer — POST /api/maintenance/reset', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.adminHttp.close();
  });

  it('returns 200 with a numeric topics_cleared', async () => {
    const { baseUrl } = harness;

    const res = await fetch(`${baseUrl}/api/maintenance/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { topics_cleared: number };
    expect(typeof body.topics_cleared).toBe('number');
  });

  it('blank-slates server state so the scheduler forgets registered trains', async () => {
    const { client, baseUrl, server } = harness;
    publishWireEvent(client, 'device_registered', 'T1', {
      capabilities: ['core.controls_motion'],
    });
    expect(server.getScheduler().getTrainIds()).toContain('T1');

    await fetch(`${baseUrl}/api/maintenance/reset`, { method: 'POST' });

    expect(server.getScheduler().getTrainIds()).toEqual([]);
  });
});

describe('AdminHttpServer — CORS includes DELETE', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.adminHttp.close();
  });

  it('preflight response includes DELETE in Allow-Methods', async () => {
    const { baseUrl } = harness;

    const res = await fetch(`${baseUrl}/api/trains/T1`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    const allow = res.headers.get('access-control-allow-methods') ?? '';
    expect(allow).toContain('DELETE');
  });
});
