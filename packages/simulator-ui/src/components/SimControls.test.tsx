import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import { SIMPLE_LOOP } from '../sim/layouts.js';
import { SimRunner } from '../sim/sim-runner.js';
import { SimControls } from './SimControls.js';

function renderControls() {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test');
  const view = render(
    <BrokerProvider client={client}>
      <SimControls layout={SIMPLE_LOOP} />
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

  it('form default values: train_id is T1, overshoot_rate is 0, miss_rate is 0.01', () => {
    renderControls();

    const trainIdInput = screen.getByRole('textbox', { name: /train id/i });
    expect(trainIdInput).toHaveValue('T1');

    const overshootInput = screen.getByRole('spinbutton', { name: /overshoot rate/i });
    expect(overshootInput).toHaveValue(0);

    const missRateInput = screen.getByRole('spinbutton', { name: /miss rate/i });
    expect(missRateInput).toHaveValue(0.01);
  });

  it('submitting with overshoot_rate=0.5 calls SimRunner.spawnTrain with that config', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(SimRunner.prototype, 'spawnTrain');

    renderControls();

    const overshootInput = screen.getByRole('spinbutton', { name: /overshoot rate/i });
    await user.clear(overshootInput);
    await user.type(overshootInput, '0.5');

    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(spy).toHaveBeenCalledOnce();
    const [, , config] = spy.mock.calls[0] ?? [];
    expect(config).toMatchObject({ overshoot_rate: 0.5 });

    spy.mockRestore();
  });
});
