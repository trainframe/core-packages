import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Layout } from '@trainframe/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import { SIMPLE_LOOP } from '../sim/layouts.js';
import { SimRunner } from '../sim/sim-runner.js';
import { SimControls } from './SimControls.js';

function renderControls(layout: Layout = SIMPLE_LOOP) {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test');
  const view = render(
    <BrokerProvider client={client}>
      <SimControls layout={layout} />
    </BrokerProvider>,
  );
  return { client, ...view };
}

/** A layout with no edges — represents the "empty layout" edge case. */
const EDGELESS_LAYOUT: Layout = {
  name: 'edgeless',
  markers: [{ id: 'M1', kind: 'block_boundary' }],
  edges: [],
  junctions: [],
};

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

  it('spawning from idle leaves the sim running so the train moves without extra clicks', async () => {
    const user = userEvent.setup();
    renderControls();

    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.getByTestId('sim-status')).toHaveTextContent('running');
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

  it('shows an empty-layout hint when the layout has no edges and Spawn is disabled', () => {
    renderControls(EDGELESS_LAYOUT);

    expect(screen.getByRole('button', { name: /spawn train/i })).toBeDisabled();
    expect(screen.getByTestId('spawn-disabled-hint')).toBeInTheDocument();
    expect(screen.getByTestId('spawn-disabled-hint')).toHaveTextContent(/add at least one edge/i);
  });

  it('does not show the empty-layout hint when the layout has edges', () => {
    renderControls();

    expect(screen.queryByTestId('spawn-disabled-hint')).not.toBeInTheDocument();
  });

  it('shows a duplicate-id error and does not advance the counter when the operator re-uses a train ID', async () => {
    const user = userEvent.setup();
    renderControls();

    // Spawn T1 — succeeds, counter advances to T2.
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    const trainIdInput = screen.getByRole('textbox', { name: /train id/i });
    expect(trainIdInput).toHaveValue('T2');

    // Change back to T1 and try again.
    await user.clear(trainIdInput);
    await user.type(trainIdInput, 'T1');
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    // Error appears; the counter has NOT advanced past T2.
    const errorEl = screen.getByTestId('spawn-error');
    expect(errorEl).toHaveAttribute('role', 'alert');
    expect(errorEl).toHaveTextContent(/T1 already exists/i);
    expect(trainIdInput).toHaveValue('T1');
  });

  it('clears the duplicate-id error after the operator fixes the ID and spawns successfully', async () => {
    const user = userEvent.setup();
    renderControls();

    // Cause the error.
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    const trainIdInput = screen.getByRole('textbox', { name: /train id/i });
    await user.clear(trainIdInput);
    await user.type(trainIdInput, 'T1');
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    expect(screen.getByTestId('spawn-error')).toBeInTheDocument();

    // Fix the ID to a fresh one and spawn again.
    await user.clear(trainIdInput);
    await user.type(trainIdInput, 'T2');
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.queryByTestId('spawn-error')).not.toBeInTheDocument();
  });
});
