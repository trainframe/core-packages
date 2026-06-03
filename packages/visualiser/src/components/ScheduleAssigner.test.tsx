import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { ScheduleAssigner } from './ScheduleAssigner.js';

function makeClient(): InMemoryBrokerSubscriber {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  return client;
}

function renderAssigner(client: InMemoryBrokerSubscriber = makeClient()) {
  return {
    client,
    ...render(
      <BrokerProvider client={client}>
        <ScheduleAssigner />
      </BrokerProvider>,
    ),
  };
}

function deliverLayout(client: InMemoryBrokerSubscriber, markerIds: ReadonlyArray<string>): void {
  client.deliver({
    topic: 'railway/state/layout/demo',
    payload: new TextEncoder().encode(
      JSON.stringify({
        name: 'demo',
        markers: markerIds.map((id) => ({ id, kind: 'block_boundary' })),
        edges: [],
        junctions: [],
      }),
    ),
  });
}

function deliverTrain(client: InMemoryBrokerSubscriber, trainId: string): void {
  client.deliver({
    topic: `railway/state/devices/${trainId}`,
    payload: new TextEncoder().encode(JSON.stringify({ capabilities: ['core.controls_motion'] })),
  });
}

describe('ScheduleAssigner', () => {
  it('hides itself when there is no layout', () => {
    const { container } = renderAssigner();
    expect(container).toBeEmptyDOMElement();
  });

  it('hides itself when there are no trains', () => {
    const { client, container } = renderAssigner();
    deliverLayout(client, ['M1', 'M2']);
    // Still no trains, so still hidden.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the form once a layout and at least one train arrive', async () => {
    const { client } = renderAssigner();
    deliverLayout(client, ['M1', 'M2']);
    deliverTrain(client, 'T1');
    await screen.findByTestId('schedule-assigner');
  });

  it('publishes a railway/operator/assign_schedule message when the operator submits', async () => {
    const user = userEvent.setup();
    const { client } = renderAssigner();
    deliverLayout(client, ['M1', 'M2', 'M3']);
    deliverTrain(client, 'T1');
    await screen.findByTestId('schedule-assigner');

    // Build the stops list: M1 then M3.
    const stopSelect = screen.getByRole('combobox', { name: /first stop/i });
    await user.selectOptions(stopSelect, 'M1');
    await user.click(screen.getByRole('button', { name: /add stop/i }));
    await user.selectOptions(screen.getByRole('combobox', { name: /next stop/i }), 'M3');
    await user.click(screen.getByRole('button', { name: /add stop/i }));

    await user.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() => {
      const sent = client.published.find((m) => m.topic === 'railway/operator/assign_schedule');
      expect(sent).toBeDefined();
      if (!sent) return;
      const body = JSON.parse(new TextDecoder().decode(sent.payload)) as {
        train_id: string;
        stops: ReadonlyArray<string>;
      };
      expect(body.train_id).toBe('T1');
      expect(body.stops).toEqual(['M1', 'M3']);
    });

    // Confirmation text appears.
    await screen.findByTestId('schedule-assigner-sent');
  });

  it('disables Assign until at least one stop is picked', async () => {
    const user = userEvent.setup();
    const { client } = renderAssigner();
    deliverLayout(client, ['M1', 'M2']);
    deliverTrain(client, 'T1');
    await screen.findByTestId('schedule-assigner');
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: /first stop/i }), 'M1');
    await user.click(screen.getByRole('button', { name: /add stop/i }));
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeEnabled();
  });
});
