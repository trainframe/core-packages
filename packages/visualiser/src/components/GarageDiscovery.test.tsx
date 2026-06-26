import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { GarageDiscovery } from './GarageDiscovery.js';

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  render(
    <BrokerProvider client={client}>
      <GarageDiscovery />
    </BrokerProvider>,
  );
  return client;
}

function announce(
  client: InMemoryBrokerSubscriber,
  deviceId: string,
  ref: string,
  kind: string,
): void {
  act(() => {
    client.deliver({
      topic: `railway/events/device_discovered/${deviceId}`,
      payload: new TextEncoder().encode(
        JSON.stringify({
          event_type: 'device_discovered',
          payload: { device_ref: ref, device_kind_hint: kind },
        }),
      ),
    });
  });
}

describe('GarageDiscovery', () => {
  it('is silent with nothing pending', () => {
    setup();
    expect(screen.queryByTestId('garage-discovery')).toBeNull();
  });

  it('surfaces an announced device and associates it with one scanned tag — no naming', () => {
    const client = setup();
    announce(client, 'DEV-SW-mac1', 'SW-mac1', 'mainline-switch');

    expect(screen.getByTestId('discovered-SW-mac1')).toBeInTheDocument();
    /* No name field exists — only a scanned-tag input. */
    expect(screen.queryByLabelText(/name/i)).toBeNull();

    fireEvent.change(screen.getByTestId('tag-SW-mac1'), { target: { value: 'M-junction-9' } });
    fireEvent.click(screen.getByTestId('associate-SW-mac1'));

    const assoc = client.published.find((m) => m.topic.includes('/device_association/'));
    expect(assoc).toBeDefined();
    const env = JSON.parse(new TextDecoder().decode(assoc?.payload ?? new Uint8Array())) as {
      payload: { device_ref: string; tag_id: string };
    };
    expect(env.payload).toEqual({ device_ref: 'SW-mac1', tag_id: 'M-junction-9' });
  });

  it('drops the row once the device registers', () => {
    const client = setup();
    announce(client, 'DEV-SW-mac1', 'SW-mac1', 'mainline-switch');
    expect(screen.getByTestId('discovered-SW-mac1')).toBeInTheDocument();

    act(() => {
      client.deliver({
        topic: 'railway/state/devices/DEV-SW-mac1',
        payload: new TextEncoder().encode(
          JSON.stringify({ capabilities: ['core.controls_switch'] }),
        ),
      });
    });
    expect(screen.queryByTestId('discovered-SW-mac1')).toBeNull();
  });
});
