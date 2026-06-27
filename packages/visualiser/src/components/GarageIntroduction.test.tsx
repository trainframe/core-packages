import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { GarageIntroduction } from './GarageIntroduction.js';

function makeClient(): InMemoryBrokerSubscriber {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  return client;
}

function renderComponent(client: InMemoryBrokerSubscriber = makeClient()) {
  return {
    client,
    ...render(
      <BrokerProvider client={client}>
        <GarageIntroduction />
      </BrokerProvider>,
    ),
  };
}

function deliverDevice(
  client: InMemoryBrokerSubscriber,
  deviceId: string,
  capabilities: ReadonlyArray<string>,
  extra: Record<string, unknown> = {},
): void {
  act(() => {
    client.deliver({
      topic: `railway/state/devices/${deviceId}`,
      payload: new TextEncoder().encode(JSON.stringify({ capabilities, ...extra })),
    });
  });
}

describe('GarageIntroduction', () => {
  it('renders nothing when no trains are registered', () => {
    const { container } = renderComponent();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the only motion device is already introduced', () => {
    const { client } = renderComponent();
    deliverDevice(client, 'T1', ['core.controls_motion'], { introduced: true });
    expect(screen.queryByTestId('garage-introduction')).toBeNull();
  });

  it('renders nothing when a non-motion device is registered (no controls_motion)', () => {
    const { client } = renderComponent();
    deliverDevice(client, 'SW1', ['core.controls_switch']);
    expect(screen.queryByTestId('garage-introduction')).toBeNull();
  });

  it('lists a controls_motion device with introduced absent (undefined)', () => {
    const { client } = renderComponent();
    deliverDevice(client, 'T1', ['core.controls_motion']);
    expect(screen.getByTestId('garage-introduction')).toBeInTheDocument();
    expect(screen.getByTestId('introduce-item-T1')).toBeInTheDocument();
  });

  it('lists a controls_motion device with introduced explicitly false', () => {
    const { client } = renderComponent();
    deliverDevice(client, 'T1', ['core.controls_motion'], { introduced: false });
    expect(screen.getByTestId('garage-introduction')).toBeInTheDocument();
    expect(screen.getByTestId('introduce-item-T1')).toBeInTheDocument();
  });

  it('clicking Introduce publishes railway/operator/introduce_train with the correct train_id', async () => {
    const user = userEvent.setup();
    const { client } = renderComponent();
    deliverDevice(client, 'T2', ['core.controls_motion', 'core.accepts_route']);

    await user.click(screen.getByTestId('introduce-btn-T2'));

    const sent = client.published.find((m) => m.topic === 'railway/operator/introduce_train');
    expect(sent).toBeDefined();
    if (!sent) return;
    const body = JSON.parse(new TextDecoder().decode(sent.payload)) as { train_id: string };
    expect(body.train_id).toBe('T2');
  });

  it('drops the row once introduced becomes true', () => {
    const { client } = renderComponent();
    deliverDevice(client, 'T3', ['core.controls_motion']);
    expect(screen.getByTestId('introduce-item-T3')).toBeInTheDocument();

    deliverDevice(client, 'T3', ['core.controls_motion'], { introduced: true });
    expect(screen.queryByTestId('introduce-item-T3')).toBeNull();
  });
});
