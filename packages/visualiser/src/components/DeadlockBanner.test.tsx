import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { DeadlockBanner } from './DeadlockBanner.js';

function makeClient(): InMemoryBrokerSubscriber {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  return client;
}

function renderBanner(client: InMemoryBrokerSubscriber = makeClient()) {
  return {
    client,
    ...render(
      <BrokerProvider client={client}>
        <DeadlockBanner />
      </BrokerProvider>,
    ),
  };
}

function publishDeadlockState(client: InMemoryBrokerSubscriber, trains: readonly string[]): void {
  const payload = new TextEncoder().encode(JSON.stringify({ trains }));
  client.deliver({ topic: 'railway/state/deadlock/active', payload });
}

describe('DeadlockBanner', () => {
  it('renders nothing when no deadlock is active', () => {
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the train list when a deadlock state is published', async () => {
    const { client } = renderBanner();
    publishDeadlockState(client, ['T1', 'T2']);
    await screen.findByTestId('deadlock-banner');
    const banner = screen.getByTestId('deadlock-banner');
    expect(banner).toHaveTextContent('T1');
    expect(banner).toHaveTextContent('T2');
    expect(banner).toHaveTextContent(/deadlock/i);
  });

  it('clears the banner when the deadlock resolves (empty trains)', async () => {
    const { client } = renderBanner();
    publishDeadlockState(client, ['T1', 'T2']);
    await screen.findByTestId('deadlock-banner');
    publishDeadlockState(client, []);
    // After resolution the alert role element should no longer be in the DOM.
    await waitFor(() => {
      expect(screen.queryByTestId('deadlock-banner')).not.toBeInTheDocument();
    });
  });
});
