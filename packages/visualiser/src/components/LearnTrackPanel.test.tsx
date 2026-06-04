import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { LearnTrackPanel } from './LearnTrackPanel.js';

function makeClient(): InMemoryBrokerSubscriber {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  return client;
}

function renderPanel(client: InMemoryBrokerSubscriber = makeClient()) {
  return {
    client,
    ...render(
      <BrokerProvider client={client}>
        <LearnTrackPanel />
      </BrokerProvider>,
    ),
  };
}

function deliverState(client: InMemoryBrokerSubscriber, state: unknown): void {
  client.deliver({
    topic: 'railway/state/track_learning/active',
    payload: new TextEncoder().encode(JSON.stringify(state)),
  });
}

describe('LearnTrackPanel', () => {
  it('renders the Learn track button in the idle state', () => {
    renderPanel();
    expect(screen.getByTestId('learn-track-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /learn track/i })).toBeInTheDocument();
    expect(screen.getByTestId('learn-track-status')).toHaveTextContent(/idle/i);
  });

  it('publishes railway/operator/learn_track_start when clicked while idle', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    await user.click(screen.getByRole('button', { name: /learn track/i }));
    const sent = client.published.find((m) => m.topic === 'railway/operator/learn_track_start');
    expect(sent).toBeDefined();
  });

  it('switches to Stop learning while active and publishes learn_track_stop on click', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    act(() => deliverState(client, { state: 'driving', train_id: 'T1', markers_visited: 3 }));
    expect(screen.getByRole('button', { name: /stop learning/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /stop learning/i }));
    const sent = client.published.find((m) => m.topic === 'railway/operator/learn_track_stop');
    expect(sent).toBeDefined();
  });

  it('shows the waiting_for_train hint when no train has been seen yet', () => {
    const { client } = renderPanel();
    act(() => deliverState(client, { state: 'waiting_for_train' }));
    expect(screen.getByTestId('learn-track-status')).toHaveTextContent(
      /place a single train on the track/i,
    );
  });

  it('shows a live marker counter while driving', () => {
    const { client } = renderPanel();
    act(() => deliverState(client, { state: 'driving', train_id: 'T-1', markers_visited: 4 }));
    expect(screen.getByTestId('learn-track-status')).toHaveTextContent(
      /T-1 has visited 4 markers/i,
    );
  });

  it('explains paused_terminus and tells the operator what to do', () => {
    const { client } = renderPanel();
    act(() =>
      deliverState(client, { state: 'paused_terminus', train_id: 'T-1', markers_visited: 3 }),
    );
    expect(screen.getByTestId('learn-track-status')).toHaveTextContent(/dead end/i);
    expect(screen.getByTestId('learn-track-status')).toHaveTextContent(/pick it up/i);
  });

  it('shows the complete summary with marker and edge counts', () => {
    const { client } = renderPanel();
    act(() =>
      deliverState(client, {
        state: 'complete',
        train_id: 'T-1',
        markers_visited: 5,
        edges_learned: 5,
      }),
    );
    expect(screen.getByTestId('learn-track-status')).toHaveTextContent(/Done!/);
    expect(screen.getByTestId('learn-track-status')).toHaveTextContent(/5 markers/);
    expect(screen.getByTestId('learn-track-status')).toHaveTextContent(/5 edges/);
  });
});
