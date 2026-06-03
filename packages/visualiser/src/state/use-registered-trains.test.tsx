import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { useRegisteredTrains } from './use-registered-trains.js';

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const { result } = renderHook(() => useRegisteredTrains(), {
    wrapper: ({ children }) => <BrokerProvider client={client}>{children}</BrokerProvider>,
  });
  return { client, result };
}

function deliverDevice(
  client: InMemoryBrokerSubscriber,
  deviceId: string,
  capabilities: ReadonlyArray<string>,
): void {
  client.deliver({
    topic: `railway/state/devices/${deviceId}`,
    payload: new TextEncoder().encode(JSON.stringify({ capabilities })),
  });
}

describe('useRegisteredTrains', () => {
  it('returns an empty list before any device snapshots arrive', () => {
    const { result } = setup();
    expect(result.current).toEqual([]);
  });

  it('adds trains as their device snapshots land', async () => {
    const { client, result } = setup();
    deliverDevice(client, 'T1', ['core.controls_motion', 'core.accepts_route']);
    deliverDevice(client, 'T2', ['core.controls_motion']);
    await waitFor(() => expect(result.current).toEqual(['T1', 'T2']));
  });

  it('ignores non-train devices (no core.controls_motion capability)', async () => {
    const { client, result } = setup();
    deliverDevice(client, 'GATE-M3', ['core.gates_clearance']);
    deliverDevice(client, 'T1', ['core.controls_motion']);
    await waitFor(() => expect(result.current).toEqual(['T1']));
  });

  it('removes a train when its capabilities snapshot empties out', async () => {
    const { client, result } = setup();
    deliverDevice(client, 'T1', ['core.controls_motion']);
    await waitFor(() => expect(result.current).toEqual(['T1']));
    // Empty payload (sent on disconnect) — train should disappear from the
    // registry.
    client.deliver({
      topic: 'railway/state/devices/T1',
      payload: new TextEncoder().encode(''),
    });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('sorts the train list alphabetically for stable UI order', async () => {
    const { client, result } = setup();
    deliverDevice(client, 'T2', ['core.controls_motion']);
    deliverDevice(client, 'T1', ['core.controls_motion']);
    deliverDevice(client, 'T10', ['core.controls_motion']);
    await waitFor(() => expect(result.current).toEqual(['T1', 'T10', 'T2']));
  });
});
