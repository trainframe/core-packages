import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { useRegisteredDevices } from './use-registered-devices.js';

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const { result } = renderHook(() => useRegisteredDevices(), {
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

describe('useRegisteredDevices', () => {
  it('returns an empty map before any device snapshots arrive', () => {
    const { result } = setup();
    expect(result.current.size).toBe(0);
  });

  it('keeps a train and a gate together — every device, not just trains', async () => {
    const { client, result } = setup();
    deliverDevice(client, 'T1', ['core.controls_motion', 'core.accepts_route']);
    deliverDevice(client, 'GATE-M3', ['core.gates_clearance']);
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('T1')?.capabilities).toEqual([
      'core.controls_motion',
      'core.accepts_route',
    ]);
    expect(result.current.get('GATE-M3')?.capabilities).toEqual(['core.gates_clearance']);
  });

  it('drops a device when its retained payload empties out (disconnect)', async () => {
    const { client, result } = setup();
    deliverDevice(client, 'T1', ['core.controls_motion']);
    await waitFor(() => expect(result.current.has('T1')).toBe(true));
    client.deliver({
      topic: 'railway/state/devices/T1',
      payload: new TextEncoder().encode(''),
    });
    await waitFor(() => expect(result.current.has('T1')).toBe(false));
  });

  it('returns a stable map reference when an unchanged snapshot is re-delivered', async () => {
    const { client, result } = setup();
    deliverDevice(client, 'GARAGE', ['core.assigns_tags']);
    await waitFor(() => expect(result.current.has('GARAGE')).toBe(true));
    const first = result.current;
    deliverDevice(client, 'GARAGE', ['core.assigns_tags']);
    expect(result.current).toBe(first);
  });

  it('ignores garbage payloads — non-JSON and missing capabilities arrays', async () => {
    const { client, result } = setup();
    client.deliver({
      topic: 'railway/state/devices/T1',
      payload: new TextEncoder().encode('not-json'),
    });
    client.deliver({
      topic: 'railway/state/devices/T2',
      payload: new TextEncoder().encode(JSON.stringify({ no_caps: true })),
    });
    client.deliver({
      topic: 'railway/state/devices/T3',
      payload: new TextEncoder().encode(JSON.stringify({ capabilities: 'not-an-array' })),
    });
    client.deliver({
      topic: 'railway/state/devices/T4',
      payload: new TextEncoder().encode(JSON.stringify({ capabilities: [1, 2, 3] })),
    });
    // None of those should land.
    deliverDevice(client, 'T5', ['core.controls_motion']);
    await waitFor(() => expect(result.current.has('T5')).toBe(true));
    expect(result.current.size).toBe(1);
  });
});
