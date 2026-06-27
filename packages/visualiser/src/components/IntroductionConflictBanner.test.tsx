import { render, screen, waitFor } from '@testing-library/react';
import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { IntroductionConflictBanner } from './IntroductionConflictBanner.js';

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
        <IntroductionConflictBanner />
      </BrokerProvider>,
    ),
  };
}

/**
 * Deliver an ENVELOPED conflict event — the exact CoreEvent shape
 * `@trainframe/server` publishes (envelope wrapping a `payload` object). This
 * proves the banner renders from a PRODUCTION-shaped event, exercising the
 * hook's enveloped-fallback parse path rather than a bare top-level payload.
 */
function publishConflict(
  client: InMemoryBrokerSubscriber,
  trainId: string,
  conflictingId: string,
  blockEdge: { from_marker_id: string; to_marker_id: string },
  reason = 'occupied',
): void {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      event_id: `evt-${trainId}-conflict`,
      device_id: 'server',
      timestamp_device: '2026-06-27T00:00:00.000Z',
      event_type: 'train_introduction_conflict',
      protocol_version: PROTOCOL_VERSION,
      payload: {
        train_id: trainId,
        conflicting_train_id: conflictingId,
        block_edge: blockEdge,
        reason,
      },
    }),
  );
  client.deliver({
    topic: 'railway/events/train_introduction_conflict/server',
    payload,
  });
}

describe('IntroductionConflictBanner', () => {
  it('renders nothing when no conflict has occurred', () => {
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a conflict alert naming both trains and the contested block', async () => {
    const { client } = renderBanner();
    publishConflict(client, 'T1', 'T2', { from_marker_id: 'M-A', to_marker_id: 'M-B' });

    await screen.findByTestId('introduction-conflict-banner');
    const banner = screen.getByTestId('introduction-conflict-banner');
    expect(banner).toHaveTextContent('T1');
    expect(banner).toHaveTextContent('T2');
    expect(banner).toHaveTextContent('M-A');
    expect(banner).toHaveTextContent('M-B');
  });

  it('names both trains via data-train-id attributes', async () => {
    const { client } = renderBanner();
    publishConflict(client, 'LOCO-1', 'LOCO-2', { from_marker_id: 'M1', to_marker_id: 'M2' });

    await screen.findByTestId('introduction-conflict-banner');
    const banner = screen.getByTestId('introduction-conflict-banner');
    const trainSpans = banner.querySelectorAll('[data-train-id]');
    const ids = [...trainSpans].map((el) => el.getAttribute('data-train-id'));
    expect(ids).toContain('LOCO-1');
    expect(ids).toContain('LOCO-2');
  });

  it('replaces the conflict when a second event arrives', async () => {
    const { client } = renderBanner();
    publishConflict(client, 'T1', 'T2', { from_marker_id: 'M-A', to_marker_id: 'M-B' });
    await screen.findByTestId('introduction-conflict-banner');

    publishConflict(client, 'T3', 'T4', { from_marker_id: 'M-C', to_marker_id: 'M-D' });
    await waitFor(() => {
      const banner = screen.getByTestId('introduction-conflict-banner');
      expect(banner).toHaveTextContent('T3');
      expect(banner).toHaveTextContent('T4');
    });
  });
});
