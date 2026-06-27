import { act, renderHook } from '@testing-library/react';
import { PROTOCOL_VERSION } from '@trainframe/protocol';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { useIntroductionConflict } from './use-introduction-conflict.js';

interface ConflictBody {
  train_id: string;
  conflicting_train_id: string;
  block_edge: { from_marker_id: string; to_marker_id: string };
  reason: string;
}

const TOPIC_PREFIX = 'railway/events/train_introduction_conflict';

/**
 * Deliver an ENVELOPED conflict event — the exact shape `@trainframe/server`
 * publishes (CoreEvent envelope wrapping a `payload` object). This is the
 * PRODUCTION path: the hook's `extractConflict(parsed.payload)` fallback.
 */
function deliverEnveloped(client: InMemoryBrokerSubscriber, body: ConflictBody): void {
  client.deliver({
    topic: `${TOPIC_PREFIX}/server`,
    payload: new TextEncoder().encode(
      JSON.stringify({
        event_id: `evt-${body.train_id}-conflict`,
        device_id: 'server',
        timestamp_device: '2026-06-27T00:00:00.000Z',
        event_type: 'train_introduction_conflict',
        protocol_version: PROTOCOL_VERSION,
        payload: body,
      }),
    ),
  });
}

/** Deliver a BARE conflict payload (top-level fields, no envelope). */
function deliverBare(client: InMemoryBrokerSubscriber, body: ConflictBody): void {
  client.deliver({
    topic: `${TOPIC_PREFIX}/${body.train_id}`,
    payload: new TextEncoder().encode(JSON.stringify(body)),
  });
}

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const wrapper = ({ children }: { children: ReactNode }) => BrokerProvider({ client, children });
  const { result } = renderHook(() => useIntroductionConflict(), { wrapper });
  return { client, result };
}

const SAMPLE: ConflictBody = {
  train_id: 'T1',
  conflicting_train_id: 'T2',
  block_edge: { from_marker_id: 'M-A', to_marker_id: 'M-B' },
  reason: 'occupied',
};

describe('useIntroductionConflict', () => {
  it('returns null before any event arrives', () => {
    const { result } = setup();
    expect(result.current).toBeNull();
  });

  it('parses the ENVELOPED server shape (production path)', () => {
    const { client, result } = setup();
    act(() => deliverEnveloped(client, SAMPLE));

    expect(result.current).not.toBeNull();
    expect(result.current?.train_id).toBe('T1');
    expect(result.current?.conflicting_train_id).toBe('T2');
    expect(result.current?.block_edge).toEqual({ from_marker_id: 'M-A', to_marker_id: 'M-B' });
    expect(result.current?.reason).toBe('occupied');
  });

  it('parses the BARE payload shape', () => {
    const { client, result } = setup();
    act(() => deliverBare(client, SAMPLE));

    expect(result.current?.train_id).toBe('T1');
    expect(result.current?.conflicting_train_id).toBe('T2');
    expect(result.current?.block_edge).toEqual({ from_marker_id: 'M-A', to_marker_id: 'M-B' });
    expect(result.current?.reason).toBe('occupied');
  });

  it('keeps the latest conflict when a second enveloped event arrives', () => {
    const { client, result } = setup();
    act(() => deliverEnveloped(client, SAMPLE));
    act(() =>
      deliverEnveloped(client, {
        train_id: 'T3',
        conflicting_train_id: 'T4',
        block_edge: { from_marker_id: 'M-C', to_marker_id: 'M-D' },
        reason: 'occupied',
      }),
    );

    expect(result.current?.train_id).toBe('T3');
    expect(result.current?.conflicting_train_id).toBe('T4');
  });

  it('ignores garbage and malformed payloads', () => {
    const { client, result } = setup();

    /* non-JSON */
    act(() =>
      client.deliver({
        topic: `${TOPIC_PREFIX}/x`,
        payload: new TextEncoder().encode('not-json'),
      }),
    );
    /* empty */
    act(() =>
      client.deliver({
        topic: `${TOPIC_PREFIX}/x`,
        payload: new TextEncoder().encode(''),
      }),
    );
    /* enveloped but payload missing required fields */
    act(() =>
      client.deliver({
        topic: `${TOPIC_PREFIX}/x`,
        payload: new TextEncoder().encode(JSON.stringify({ payload: { train_id: 'T1' } })),
      }),
    );

    expect(result.current).toBeNull();
  });
});
