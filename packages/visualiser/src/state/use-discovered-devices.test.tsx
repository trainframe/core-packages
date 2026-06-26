import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { useDiscoveredDevices } from './use-discovered-devices.js';

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const { result } = renderHook(() => useDiscoveredDevices(), {
    wrapper: ({ children }) => <BrokerProvider client={client}>{children}</BrokerProvider>,
  });
  return { client, result };
}

function deliverDiscovered(
  client: InMemoryBrokerSubscriber,
  deviceId: string,
  deviceRef: string,
  kind: string,
): void {
  client.deliver({
    topic: `railway/events/device_discovered/${deviceId}`,
    payload: new TextEncoder().encode(
      JSON.stringify({
        event_type: 'device_discovered',
        payload: { device_ref: deviceRef, device_kind_hint: kind },
      }),
    ),
  });
}

describe('useDiscoveredDevices', () => {
  it('surfaces an announced device and lets the operator associate it with a scanned tag', async () => {
    const { client, result } = setup();
    deliverDiscovered(client, 'DEV-SW-mac1', 'SW-mac1', 'mainline-switch');

    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.pending[0]?.device_ref).toBe('SW-mac1');
    expect(result.current.pending[0]?.device_kind_hint).toBe('mainline-switch');

    result.current.associate('SW-mac1', 'M-junction-9');
    const assoc = client.published.find((m) => m.topic.includes('/device_association/'));
    expect(assoc, 'a device_association event was published').toBeDefined();
    const env = JSON.parse(new TextDecoder().decode(assoc?.payload ?? new Uint8Array())) as {
      payload: { device_ref: string; tag_id: string };
    };
    expect(env.payload).toEqual({ device_ref: 'SW-mac1', tag_id: 'M-junction-9' });
  });

  it('drops a discovered device once it registers (its retained device state lands)', async () => {
    const { client, result } = setup();
    deliverDiscovered(client, 'DEV-SW-mac1', 'SW-mac1', 'mainline-switch');
    await waitFor(() => expect(result.current.pending).toHaveLength(1));

    client.deliver({
      topic: 'railway/state/devices/DEV-SW-mac1',
      payload: new TextEncoder().encode(JSON.stringify({ capabilities: ['core.controls_switch'] })),
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(0));
  });

  it('ignores a malformed device_discovered payload', async () => {
    const { client, result } = setup();
    client.deliver({
      topic: 'railway/events/device_discovered/DEV-x',
      payload: new TextEncoder().encode('not json'),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.pending).toHaveLength(0);
  });
});
