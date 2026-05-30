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

describe('SimControls — operator panel', () => {
  it('opens with no trains, Spawn available, and Pause/Stop not yet meaningful', () => {
    renderControls();

    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /spawn train/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeDisabled();
  });

  it('spawning a train surfaces it in the panel and registers it on the broker', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.getByText('T1')).toBeInTheDocument();
    const registered = client.published.find((m) =>
      m.topic.startsWith('railway/events/device_registered/T1'),
    );
    expect(registered).toBeDefined();
  });

  it('stepping the sim after spawn produces marker_traversed events for the train', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    for (let i = 0; i < 3; i++) {
      await user.click(screen.getByRole('button', { name: /^step 1s$/i }));
    }

    const traversal = client.published.find((m) =>
      m.topic.startsWith('railway/events/marker_traversed/'),
    );
    expect(traversal).toBeDefined();
  });

  it('stopping the sim after spawn clears the train list back to none', async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    expect(screen.getByText('T1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^stop$/i }));
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('the spawn form shows sensible defaults the operator can adjust', () => {
    renderControls();

    expect(screen.getByRole('textbox', { name: /train id/i })).toHaveValue('T1');
    expect(screen.getByRole('spinbutton', { name: /overshoot rate/i })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: /miss rate/i })).toHaveValue(0.01);
  });

  it('the overshoot rate the operator types is applied to the spawned train', async () => {
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
