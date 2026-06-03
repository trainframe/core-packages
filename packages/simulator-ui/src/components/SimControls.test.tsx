import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import { SIMPLE_LOOP } from '../sim/layouts.js';
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

/** A layout with markers but no edges — no spawn position is valid. */
const EDGELESS_LAYOUT: Layout = {
  name: 'edgeless',
  markers: [{ id: 'M1', kind: 'block_boundary' }],
  edges: [],
  junctions: [],
};

/** Place a train at the given starting position via the spawn form. */
async function spawn(
  user: ReturnType<typeof userEvent.setup>,
  options: { trainId?: string; startMarker: string },
): Promise<void> {
  if (options.trainId) {
    const idInput = screen.getByRole('textbox', { name: /train id/i });
    await user.clear(idInput);
    await user.type(idInput, options.trainId);
  }
  await user.selectOptions(screen.getByTestId('spawn-position'), options.startMarker);
  await user.click(screen.getByRole('button', { name: /spawn train/i }));
}

describe('SimControls — operator panel', () => {
  it('opens with no trains and Spawn enabled (a starting position is auto-selected)', () => {
    renderControls();

    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /spawn train/i })).toBeEnabled();
  });

  it('spawning a train surfaces it in the panel and registers it on the broker', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await spawn(user, { startMarker: 'M1' });

    expect(screen.getByText('T1')).toBeInTheDocument();
    const registered = client.published.find((m) =>
      m.topic.startsWith('railway/events/device_registered/T1'),
    );
    expect(registered).toBeDefined();
  });

  it('the spawned train does NOT auto-receive a schedule — the visualiser does that', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await spawn(user, { startMarker: 'M1' });

    // No assign_route command should have been issued to the train. The
    // sim-ui's job is to physically place the train; scheduling is
    // operator-side per ADR-013.
    const assignRoute = client.published.find(
      (m) =>
        m.topic.startsWith('railway/commands/T1') &&
        JSON.parse(new TextDecoder().decode(m.payload)).command_type === 'assign_route',
    );
    expect(assignRoute).toBeUndefined();
  });

  it('offers only markers that have at least one outgoing edge as a starting position', () => {
    renderControls();
    const select = screen.getByTestId('spawn-position') as HTMLSelectElement;
    const optionValues = Array.from(select.options)
      .map((o) => o.value)
      .sort();
    // SIMPLE_LOOP: M1→M2→M3→M4→M1 — every marker has an outgoing edge.
    expect(optionValues).toEqual(['M1', 'M2', 'M3', 'M4']);
  });

  it('disables Spawn when no marker has an outgoing edge (degenerate layout)', () => {
    renderControls(EDGELESS_LAYOUT);
    expect(screen.getByRole('button', { name: /spawn train/i })).toBeDisabled();
  });

  it('shows a duplicate-id error when the operator re-uses a Train ID', async () => {
    const user = userEvent.setup();
    renderControls();

    await spawn(user, { startMarker: 'M1' });
    expect(screen.getByText('T1')).toBeInTheDocument();

    // Try to spawn T1 again at the same marker.
    const idInput = screen.getByRole('textbox', { name: /train id/i });
    await user.clear(idInput);
    await user.type(idInput, 'T1');
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/T1 already exists/i);
  });

  it('hides developer affordances behind a collapsed drawer by default', async () => {
    const user = userEvent.setup();
    renderControls();

    // Lifecycle buttons are inside the drawer — initially not visible.
    expect(screen.queryByRole('button', { name: /^pause$/i })).not.toBeInTheDocument();

    // Click the drawer toggle to reveal them.
    await user.click(screen.getByRole('button', { name: /developer/i }));
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeInTheDocument();
  });
});
