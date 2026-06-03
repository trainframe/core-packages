import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { useClearanceState } from './use-clearance-state.js';

function deliverClearance(
  client: InMemoryBrokerSubscriber,
  trainId: string,
  clearedEdges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
): void {
  client.deliver({
    topic: `railway/state/clearance/${trainId}`,
    payload: new TextEncoder().encode(
      JSON.stringify({ train_id: trainId, cleared_edges: clearedEdges }),
    ),
  });
}

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    BrokerProvider({ client, children });

  const { result } = renderHook(() => useClearanceState(), { wrapper });
  return { client, result };
}

describe('useClearanceState', () => {
  it('returns an empty map before any message arrives', () => {
    const { result } = setup();
    expect(result.current.size).toBe(0);
  });

  it('adds entries to the map when a clearance message arrives', () => {
    const { client, result } = setup();

    act(() => deliverClearance(client, 'T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]));

    expect(result.current.size).toBe(1);
    expect(result.current.get('M1->M2')).toBe('T1');
  });

  it('updates the map when a second message replaces the train`s cleared edges', () => {
    const { client, result } = setup();

    act(() => deliverClearance(client, 'T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]));
    expect(result.current.get('M1->M2')).toBe('T1');

    // Train advances: M1→M2 released, M2→M3 now held.
    act(() => deliverClearance(client, 'T1', [{ from_marker_id: 'M2', to_marker_id: 'M3' }]));

    expect(result.current.get('M1->M2')).toBeUndefined();
    expect(result.current.get('M2->M3')).toBe('T1');
    expect(result.current.size).toBe(1);
  });

  it('removes all entries for a train when an empty cleared_edges message arrives', () => {
    const { client, result } = setup();

    act(() =>
      deliverClearance(client, 'T1', [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
      ]),
    );
    expect(result.current.size).toBe(2);

    act(() => deliverClearance(client, 'T1', []));

    expect(result.current.size).toBe(0);
  });

  it('tracks multiple trains independently', () => {
    const { client, result } = setup();

    act(() => {
      deliverClearance(client, 'T1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
      deliverClearance(client, 'T2', [{ from_marker_id: 'M3', to_marker_id: 'M4' }]);
    });

    expect(result.current.get('M1->M2')).toBe('T1');
    expect(result.current.get('M3->M4')).toBe('T2');
    expect(result.current.size).toBe(2);
  });

  it('silently ignores malformed messages', () => {
    const { client, result } = setup();

    act(() =>
      client.deliver({
        topic: 'railway/state/clearance/T1',
        payload: new TextEncoder().encode('not-json'),
      }),
    );

    expect(result.current.size).toBe(0);
  });
});
