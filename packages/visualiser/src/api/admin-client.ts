/*
 * Typed client for the server's admin HTTP API. One place for every
 * operator-initiated request/response action, so components don't scatter
 * bare fetch calls. Base URL comes from the visualiser's admin-api config.
 */

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

async function request(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const message = `Server returned ${res.status}: ${text || res.statusText}`;
    throw new AdminApiError(res.status, message);
  }
  return res;
}

export async function assignTag(
  baseUrl: string,
  args: { tagId: string; kind: 'marker' | 'vehicle'; targetId: string },
): Promise<void> {
  await request(baseUrl, '/api/tags', {
    method: 'POST',
    body: JSON.stringify({
      tag_id: args.tagId,
      assigned_kind: args.kind,
      target_id: args.targetId,
    }),
  });
}

export async function revokeClearance(baseUrl: string, trainId: string): Promise<void> {
  await request(baseUrl, `/api/trains/${encodeURIComponent(trainId)}/revoke_clearance`, {
    method: 'POST',
    body: '{}',
  });
}

export async function deleteTrain(baseUrl: string, trainId: string): Promise<void> {
  await request(baseUrl, `/api/trains/${encodeURIComponent(trainId)}`, { method: 'DELETE' });
}

export async function pruneMarkers(baseUrl: string): Promise<string[]> {
  const res = await request(baseUrl, '/api/maintenance/prune-markers', {
    method: 'POST',
    body: '{}',
  });
  const body = (await res.json()) as { pruned?: string[] };
  return body.pruned ?? [];
}

export async function resetState(baseUrl: string): Promise<{ topics_cleared: number }> {
  const res = await request(baseUrl, '/api/maintenance/reset', { method: 'POST', body: '{}' });
  return (await res.json()) as { topics_cleared: number };
}
