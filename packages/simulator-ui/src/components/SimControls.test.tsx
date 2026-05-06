import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import { SimControls } from './SimControls.js';

function renderControls() {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test');
  const view = render(
    <BrokerProvider client={client}>
      <SimControls />
    </BrokerProvider>,
  );
  return { client, ...view };
}

describe('SimControls', () => {
  it('starts idle and only Start is enabled', () => {
    renderControls();

    expect(screen.getByTestId('sim-status')).toHaveTextContent('idle');
    expect(screen.getByRole('button', { name: /^start$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^step 1s$/i })).toBeDisabled();
  });

  it('transitions idle → paused on Start, then publishes a device_registered event after spawn', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await user.click(screen.getByRole('button', { name: /^start$/i }));
    expect(screen.getByTestId('sim-status')).toHaveTextContent('paused');

    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.getByText('T1')).toBeInTheDocument();
    const registered = client.published.find((m) =>
      m.topic.startsWith('railway/events/device_registered/T1'),
    );
    expect(registered).toBeDefined();
  });

  it('Step 1s drives the simulation forward and publishes marker_traversed events', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await user.click(screen.getByRole('button', { name: /^start$/i }));
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    await user.click(screen.getByRole('button', { name: /^step 1s$/i }));
    await user.click(screen.getByRole('button', { name: /^step 1s$/i }));
    await user.click(screen.getByRole('button', { name: /^step 1s$/i }));

    const traversal = client.published.find((m) =>
      m.topic.startsWith('railway/events/marker_traversed/'),
    );
    expect(traversal).toBeDefined();
  });

  it('Stop returns to idle and clears the train list', async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole('button', { name: /^start$/i }));
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    expect(screen.getByText('T1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^stop$/i }));
    expect(screen.getByTestId('sim-status')).toHaveTextContent('idle');
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});
