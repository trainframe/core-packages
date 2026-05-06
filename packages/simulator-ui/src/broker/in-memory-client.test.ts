import { describe, expect, it, vi } from 'vitest';
import { InMemoryBrokerClient } from './in-memory-client.js';

describe('InMemoryBrokerClient', () => {
  it('walks through disconnected → connecting → connected on connect', () => {
    const client = new InMemoryBrokerClient();
    const seen: string[] = [];
    client.onStatusChange((s) => seen.push(s));

    expect(client.status).toBe('disconnected');
    client.connect('ws://localhost:9001');
    expect(seen).toEqual(['connecting', 'connected']);
    expect(client.status).toBe('connected');
  });

  it('delivers messages to exact-topic subscribers', () => {
    const client = new InMemoryBrokerClient();
    const handler = vi.fn();
    client.subscribe('trainframe/events/marker_traversed', handler);

    client.deliver({
      topic: 'trainframe/events/marker_traversed',
      payload: new TextEncoder().encode('{"marker":"M1"}'),
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('matches `+` wildcard at a single level', () => {
    const client = new InMemoryBrokerClient();
    const handler = vi.fn();
    client.subscribe('trainframe/+/marker_traversed', handler);

    client.deliver({ topic: 'trainframe/events/marker_traversed', payload: new Uint8Array() });
    client.deliver({
      topic: 'trainframe/events/extra/marker_traversed',
      payload: new Uint8Array(),
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('matches `#` wildcard for any trailing segments', () => {
    const client = new InMemoryBrokerClient();
    const handler = vi.fn();
    client.subscribe('trainframe/#', handler);

    client.deliver({ topic: 'trainframe/events/x', payload: new Uint8Array() });
    client.deliver({ topic: 'trainframe/events/x/y/z', payload: new Uint8Array() });
    client.deliver({ topic: 'other/topic', payload: new Uint8Array() });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('stops delivering after unsubscribe', () => {
    const client = new InMemoryBrokerClient();
    const handler = vi.fn();
    const off = client.subscribe('t', handler);

    client.deliver({ topic: 't', payload: new Uint8Array() });
    off();
    client.deliver({ topic: 't', payload: new Uint8Array() });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('records published messages and round-trips them to subscribers', () => {
    const client = new InMemoryBrokerClient();
    const handler = vi.fn();
    client.subscribe('trainframe/events/marker_traversed', handler);

    const payload = new TextEncoder().encode('{"marker":"M1"}');
    client.publish('trainframe/events/marker_traversed', payload);

    expect(client.published).toEqual([{ topic: 'trainframe/events/marker_traversed', payload }]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('emits an error status when fail() is called', () => {
    const client = new InMemoryBrokerClient();
    const seen: Array<{ status: string; error?: Error }> = [];
    client.onStatusChange((status, error) => seen.push({ status, ...(error ? { error } : {}) }));

    const boom = new Error('boom');
    client.fail(boom);

    expect(seen).toEqual([{ status: 'error', error: boom }]);
    expect(client.status).toBe('error');
  });
});
