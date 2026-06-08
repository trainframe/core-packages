import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { useTrainEdgeHistory } from './use-train-edge-history.js';

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const { result } = renderHook(() => useTrainEdgeHistory(), {
    wrapper: ({ children }) => <BrokerProvider client={client}>{children}</BrokerProvider>,
  });
  return { client, result };
}

function deliverEvent(client: InMemoryBrokerSubscriber, topic: string, payload: unknown): void {
  client.deliver({
    topic,
    payload: new TextEncoder().encode(JSON.stringify({ payload })),
  });
}

describe('useTrainEdgeHistory', () => {
  it('starts empty before any events arrive', () => {
    const { result } = setup();
    expect(result.current.size).toBe(0);
  });

  it('records a completed edge from inferred_edge on marker_traversed', async () => {
    const { client, result } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
        inferred_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      }),
    );
    await Promise.resolve();
    const history = result.current.get('T1');
    expect(history).toBeDefined();
    expect(history?.[0]).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
  });

  it('ignores marker_traversed events that lack inferred_edge', async () => {
    const { client, result } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
        /* no inferred_edge field */
      }),
    );
    await Promise.resolve();
    expect(result.current.size).toBe(0);
  });

  it('ignores marker_traversed with malformed inferred_edge (missing from_marker_id)', async () => {
    const { client, result } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
        inferred_edge: { to_marker_id: 'M2' } /* from_marker_id absent */,
      }),
    );
    await Promise.resolve();
    expect(result.current.size).toBe(0);
  });

  it('prepends new edges and keeps them most-recent-first', async () => {
    const { client, result } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
        inferred_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      }),
    );
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M3',
        inferred_edge: { from_marker_id: 'M2', to_marker_id: 'M3' },
      }),
    );
    await Promise.resolve();
    const history = result.current.get('T1');
    expect(history?.[0]).toEqual({ from_marker_id: 'M2', to_marker_id: 'M3' });
    expect(history?.[1]).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
  });

  it('clears a train history when device_disconnected fires', async () => {
    const { client, result } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
        inferred_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      }),
    );
    await Promise.resolve();
    expect(result.current.has('T1')).toBe(true);

    act(() =>
      client.deliver({
        topic: 'railway/events/device_disconnected/T1',
        payload: new TextEncoder().encode(JSON.stringify({})),
      }),
    );
    await Promise.resolve();
    expect(result.current.has('T1')).toBe(false);
  });

  it('ignores malformed topics on device_disconnected (wrong segment count)', async () => {
    const { client, result } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
        inferred_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      }),
    );
    await Promise.resolve();
    /* Deliver a disconnect on a topic with the wrong segment count — should
     * be silently ignored, leaving T1's history intact. */
    act(() =>
      client.deliver({
        topic: 'railway/events/device_disconnected',
        payload: new TextEncoder().encode('{}'),
      }),
    );
    await Promise.resolve();
    expect(result.current.has('T1')).toBe(true);
  });

  it('ignores malformed topics on device_disconnected (wrong event type)', async () => {
    const { client, result } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
        inferred_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      }),
    );
    await Promise.resolve();
    /* Topic has right segment count but wrong event type — ignored. */
    act(() =>
      client.deliver({
        topic: 'railway/events/something_else/T1',
        payload: new TextEncoder().encode('{}'),
      }),
    );
    await Promise.resolve();
    expect(result.current.has('T1')).toBe(true);
  });

  it('ignores marker_traversed with invalid JSON payload', async () => {
    const { client, result } = setup();
    act(() =>
      client.deliver({
        topic: 'railway/events/marker_traversed/T1',
        payload: new TextEncoder().encode('not-json'),
      }),
    );
    await Promise.resolve();
    expect(result.current.size).toBe(0);
  });
});
