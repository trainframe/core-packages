import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { useLastScanned } from './use-last-scanned.js';

function setup(holdMs = 3000) {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const { result, unmount } = renderHook(() => useLastScanned({ holdMs }), {
    wrapper: ({ children }) => <BrokerProvider client={client}>{children}</BrokerProvider>,
  });
  return { client, result, unmount };
}

function deliverTagObserved(client: InMemoryBrokerSubscriber, deviceId: string, tagId: string) {
  client.deliver({
    topic: `railway/events/tag_observed/${deviceId}`,
    payload: new TextEncoder().encode(JSON.stringify({ payload: { tag_id: tagId } })),
  });
}

function deliverTagAssignment(
  client: InMemoryBrokerSubscriber,
  deviceId: string,
  targetId: string,
) {
  client.deliver({
    topic: `railway/events/tag_assignment/${deviceId}`,
    payload: new TextEncoder().encode(
      JSON.stringify({
        payload: { tag_id: 'tag-x', assigned_kind: 'marker', target_id: targetId },
      }),
    ),
  });
}

describe('useLastScanned', () => {
  beforeEach(() => {
    // Fake timers so the 3 s hold can be advanced deterministically. State
    // updates inside the `act()` blocks flush synchronously, so we don't
    // need `waitFor` (which would spin against the faked clock).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no scanned entity', () => {
    const { result } = setup();
    expect(result.current.entityId).toBeNull();
  });

  it('latches the tag_id from a tag_observed event', () => {
    const { client, result } = setup();
    act(() => deliverTagObserved(client, 'T1', 'M1'));
    expect(result.current.entityId).toBe('M1');
  });

  it('latches the target_id from a tag_assignment event', () => {
    const { client, result } = setup();
    act(() => deliverTagAssignment(client, 'GARAGE', 'M7'));
    expect(result.current.entityId).toBe('M7');
  });

  it('clears the entity after the hold expires', () => {
    const { client, result } = setup(3000);
    act(() => deliverTagObserved(client, 'T1', 'M1'));
    expect(result.current.entityId).toBe('M1');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.entityId).toBeNull();
  });

  it('resets the hold timer when a fresh scan arrives', () => {
    const { client, result } = setup(3000);
    act(() => deliverTagObserved(client, 'T1', 'M1'));
    expect(result.current.entityId).toBe('M1');
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    act(() => deliverTagObserved(client, 'T1', 'M2'));
    expect(result.current.entityId).toBe('M2');
    // 2 seconds after M2 — original M1 timer would have fired by now, but
    // the M2 timer (3 s from its arrival) shouldn't have yet.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.entityId).toBe('M2');
  });

  it('clear() empties the entity immediately', () => {
    const { client, result } = setup();
    act(() => deliverTagObserved(client, 'T1', 'M1'));
    expect(result.current.entityId).toBe('M1');
    act(() => result.current.clear());
    expect(result.current.entityId).toBeNull();
  });

  it('ignores garbage payloads', () => {
    const { client, result } = setup();
    act(() => {
      client.deliver({
        topic: 'railway/events/tag_observed/T1',
        payload: new TextEncoder().encode('not-json'),
      });
      client.deliver({
        topic: 'railway/events/tag_observed/T1',
        payload: new TextEncoder().encode(JSON.stringify({ payload: { tag_id: '' } })),
      });
      client.deliver({
        topic: 'railway/events/tag_assignment/G',
        payload: new TextEncoder().encode(JSON.stringify({ payload: { target_id: 42 } })),
      });
    });
    expect(result.current.entityId).toBeNull();
  });

  it('does not throw if the timer fires after unmount', () => {
    const { client, unmount } = setup(3000);
    act(() => deliverTagObserved(client, 'T1', 'M1'));
    unmount();
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
  });
});
