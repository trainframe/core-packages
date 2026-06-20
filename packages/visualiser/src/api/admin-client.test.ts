import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdminApiError,
  assignTag,
  deleteTrain,
  pruneMarkers,
  resetState,
  revokeClearance,
} from './admin-client.js';

afterEach(() => vi.restoreAllMocks());

describe('admin-client', () => {
  it('deleteTrain issues a DELETE and resolves on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"deleted":"T1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deleteTrain('http://h:3000', 'T 1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://h:3000/api/trains/T%201',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('throws AdminApiError with the status on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    await expect(deleteTrain('http://h:3000', 'T1')).rejects.toBeInstanceOf(AdminApiError);
  });

  it('pruneMarkers returns the pruned id array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"pruned":["A","B"]}', { status: 200 })),
    );
    expect(await pruneMarkers('http://h:3000')).toEqual(['A', 'B']);
  });

  it('assignTag sends tag assignment request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await assignTag('http://h:3000', { tagId: 'T1', kind: 'marker', targetId: 'M1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://h:3000/api/tags',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tag_id: 'T1', assigned_kind: 'marker', target_id: 'M1' }),
      }),
    );
  });

  it('revokeClearance sends revoke request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await revokeClearance('http://h:3000', 'T1');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://h:3000/api/trains/T1/revoke_clearance',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('resetState returns topics_cleared count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"topics_cleared":42}', { status: 200 })),
    );
    expect(await resetState('http://h:3000')).toEqual({ topics_cleared: 42 });
  });
});
