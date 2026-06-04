import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { useTrackLearningState } from './use-track-learning-state.js';

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    BrokerProvider({ client, children });
  const { result } = renderHook(() => useTrackLearningState(), { wrapper });
  return { client, result };
}

function deliverState(client: InMemoryBrokerSubscriber, state: unknown): void {
  client.deliver({
    topic: 'railway/state/track_learning/active',
    payload: new TextEncoder().encode(JSON.stringify(state)),
  });
}

describe('useTrackLearningState', () => {
  it('defaults to idle before any retained payload arrives', () => {
    const { result } = setup();
    expect(result.current.state).toBe('idle');
  });

  it('reflects a retained snapshot from the server', () => {
    const { client, result } = setup();
    act(() =>
      deliverState(client, {
        state: 'driving',
        train_id: 'T1',
        markers_visited: 4,
        edges_learned: 3,
        start_marker_id: 'M1',
        last_marker_id: 'M4',
      }),
    );
    expect(result.current.state).toBe('driving');
    expect(result.current.train_id).toBe('T1');
    expect(result.current.markers_visited).toBe(4);
    expect(result.current.edges_learned).toBe(3);
    expect(result.current.start_marker_id).toBe('M1');
    expect(result.current.last_marker_id).toBe('M4');
  });

  it('handles state transitions back to idle', () => {
    const { client, result } = setup();
    act(() => deliverState(client, { state: 'driving', train_id: 'T1' }));
    expect(result.current.state).toBe('driving');
    act(() => deliverState(client, { state: 'idle' }));
    expect(result.current.state).toBe('idle');
    expect(result.current.train_id).toBeUndefined();
  });

  it('ignores malformed payloads', () => {
    const { client, result } = setup();
    act(() =>
      client.deliver({
        topic: 'railway/state/track_learning/active',
        payload: new TextEncoder().encode('not-json'),
      }),
    );
    expect(result.current.state).toBe('idle');
  });

  it('ignores payloads with an unknown state value', () => {
    const { client, result } = setup();
    act(() => deliverState(client, { state: 'who_knows' }));
    expect(result.current.state).toBe('idle');
  });
});
