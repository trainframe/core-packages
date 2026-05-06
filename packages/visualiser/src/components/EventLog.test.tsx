import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { EventLog } from './EventLog.js';

function deliver(client: InMemoryBrokerSubscriber, topic: string, payload: unknown): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  client.deliver({ topic, payload: new TextEncoder().encode(text) });
}

function renderWithBroker(client: InMemoryBrokerSubscriber) {
  client.connect('ws://test');
  return render(
    <BrokerProvider client={client}>
      <EventLog />
    </BrokerProvider>,
  );
}

describe('EventLog', () => {
  it('shows an empty state before any events arrive', () => {
    renderWithBroker(new InMemoryBrokerSubscriber());
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it('renders a delivered core event with its parsed type and device id', () => {
    const client = new InMemoryBrokerSubscriber();
    renderWithBroker(client);

    act(() =>
      deliver(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
      }),
    );

    const log = screen.getByLabelText(/event log/i);
    const item = within(log).getByRole('listitem');
    expect(within(item).getByText('marker_traversed')).toBeInTheDocument();
    expect(item).toHaveTextContent(/T1/);
    expect(item).toHaveTextContent(/"marker_id":"M2"/);
  });

  it('renders a delivered custom event with its vendor segment', () => {
    const client = new InMemoryBrokerSubscriber();
    renderWithBroker(client);

    act(() =>
      deliver(client, 'railway/events/custom/com.alice/turntable_aligned/TT-1', { angle: 90 }),
    );

    const item = screen.getByRole('listitem');
    expect(within(item).getByText('turntable_aligned')).toBeInTheDocument();
    expect(item).toHaveTextContent(/TT-1/);
    expect(item).toHaveTextContent(/vendor=com\.alice/);
  });

  it('shows newest events first as more arrive', () => {
    const client = new InMemoryBrokerSubscriber();
    renderWithBroker(client);

    act(() => {
      deliver(client, 'railway/events/marker_traversed/T1', { marker_id: 'M2' });
      deliver(client, 'railway/events/clearance_granted/T1', { new_limit_marker_id: 'M3' });
    });

    const items = screen.getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByText('clearance_granted')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('marker_traversed')).toBeInTheDocument();
  });

  it('renders raw text when the payload is not JSON', () => {
    const client = new InMemoryBrokerSubscriber();
    renderWithBroker(client);

    act(() => deliver(client, 'railway/events/anomaly/server', 'broker disconnected'));

    expect(screen.getByText(/broker disconnected/)).toBeInTheDocument();
  });

  it('falls back to "(unknown)" for malformed event topics', () => {
    const client = new InMemoryBrokerSubscriber();
    renderWithBroker(client);

    // The wildcard subscription railway/events/# delivers this, but the
    // shape doesn't match the protocol convention (extra segments).
    act(() => deliver(client, 'railway/events/marker_traversed/T1/extra', { hi: 'there' }));

    expect(screen.getByText(/\(unknown\)/)).toBeInTheDocument();
  });
});
