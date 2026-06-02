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

/** A layout with no edges — represents the "empty layout" edge case. */
const EDGELESS_LAYOUT: Layout = {
  name: 'edgeless',
  markers: [{ id: 'M1', kind: 'block_boundary' }],
  edges: [],
  junctions: [],
};

/**
 * Build a route by selecting each marker in `path` from the dropdown and
 * clicking "Add to route". Mirrors how a real operator drives the panel.
 */
async function buildRoute(user: ReturnType<typeof userEvent.setup>, path: ReadonlyArray<string>) {
  for (const marker of path) {
    const dropdown = screen.getByRole('combobox', { name: /marker/i });
    await user.selectOptions(dropdown, marker);
    await user.click(screen.getByRole('button', { name: /add to route/i }));
  }
}

describe('SimControls — operator panel', () => {
  it('opens with no trains and Spawn disabled until a route is built', () => {
    renderControls();

    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /spawn train/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeDisabled();
  });

  it('spawning a train surfaces it in the panel and registers it on the broker', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await buildRoute(user, ['M1', 'M2', 'M3']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.getByText('T1')).toBeInTheDocument();
    const registered = client.published.find((m) =>
      m.topic.startsWith('railway/events/device_registered/T1'),
    );
    expect(registered).toBeDefined();
  });

  it('passes the operator-built route to the runner as edges, not a hardcoded slice', async () => {
    const user = userEvent.setup();
    // Use a layout where two routes of equal first-edge differ in their
    // onward markers. The old "demo route" (edges.slice(0,3)) would always
    // be M1→M2, M2→M3, M3→M4. We build M1→M2, M2→M5 instead — a route only
    // possible because of a branch from M2.
    const BRANCHED: Layout = {
      name: 'branched',
      markers: [
        { id: 'M1', kind: 'block_boundary' },
        { id: 'M2', kind: 'block_boundary' },
        { id: 'M3', kind: 'block_boundary' },
        { id: 'M4', kind: 'block_boundary' },
        { id: 'M5', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
        { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
        { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
        { from_marker_id: 'M2', to_marker_id: 'M5', estimated_length_mm: 200 },
      ],
      junctions: [],
    };
    const { client } = renderControls(BRANCHED);

    // Operator picks the branch route: M1 → M2 → M5.
    await buildRoute(user, ['M1', 'M2', 'M5']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    // Pause auto-run, then step enough to traverse both edges.
    await user.click(screen.getByRole('button', { name: /^pause$/i }));
    for (let i = 0; i < 6; i++) {
      await user.click(screen.getByRole('button', { name: /^step 1s$/i }));
    }

    // Collect every marker the train traversed. The scheduler emits
    // `marker_traversed` server-derived events with the marker_id and the
    // train_id in the payload — the topic suffix is `/server`.
    const traversals = client.published
      .filter((m) => m.topic.startsWith('railway/events/marker_traversed/'))
      .map((m) => {
        const env = JSON.parse(new TextDecoder().decode(m.payload)) as {
          payload: { marker_id: string; train_id?: string };
        };
        return env.payload;
      })
      .filter((p) => p.train_id === 'T1')
      .map((p) => p.marker_id);

    // The train must have visited M5 (the operator's chosen branch). A
    // hardcoded `edges.slice(0,3)` route would have sent it to M3/M4 instead.
    expect(traversals).toContain('M5');
    expect(traversals).not.toContain('M3');
  });

  it('keeps Spawn disabled until the route has at least two markers (one edge)', async () => {
    const user = userEvent.setup();
    renderControls();

    const spawn = screen.getByRole('button', { name: /spawn train/i });
    expect(spawn).toBeDisabled();

    await buildRoute(user, ['M1']);
    expect(spawn).toBeDisabled();

    await buildRoute(user, ['M2']);
    expect(spawn).toBeEnabled();
  });

  it('only offers markers reachable from the route tail after the first pick', async () => {
    const user = userEvent.setup();
    renderControls();

    // First pick is wide open — every marker is offered.
    const beforeOptions = (screen.getByRole('combobox', { name: /marker/i }) as HTMLSelectElement)
      .options;
    expect(
      Array.from(beforeOptions)
        .map((o) => o.value)
        .sort(),
    ).toEqual(['M1', 'M2', 'M3', 'M4']);

    await buildRoute(user, ['M1']);

    // From M1 in SIMPLE_LOOP only M2 is reachable.
    const afterOptions = (screen.getByRole('combobox', { name: /marker/i }) as HTMLSelectElement)
      .options;
    expect(Array.from(afterOptions).map((o) => o.value)).toEqual(['M2']);
  });

  it('Remove last truncates the route by one and Clear route resets it', async () => {
    const user = userEvent.setup();
    renderControls();

    await buildRoute(user, ['M1', 'M2', 'M3']);
    expect(screen.getByRole('list', { name: /planned route/i })).toHaveTextContent(/M1.*M2.*M3/);

    await user.click(screen.getByRole('button', { name: /remove last/i }));
    expect(screen.getByRole('list', { name: /planned route/i })).toHaveTextContent(/M1.*M2/);
    expect(screen.queryByRole('list', { name: /planned route/i })).not.toHaveTextContent(/M3/);

    await user.click(screen.getByRole('button', { name: /clear route/i }));
    expect(screen.queryByRole('list', { name: /planned route/i })).not.toBeInTheDocument();
  });

  it('spawning from idle leaves the sim running so the train moves without extra clicks', async () => {
    const user = userEvent.setup();
    renderControls();

    await buildRoute(user, ['M1', 'M2']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.getByTestId('sim-status')).toHaveTextContent('running');
  });

  it('stepping the sim after spawn produces marker_traversed events for the train', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await buildRoute(user, ['M1', 'M2', 'M3']);
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

    await buildRoute(user, ['M1', 'M2']);
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

  it('the overshoot rate the operator types causes an anomaly event on the broker when the train overshoots', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    // Set overshoot to 1 — brakes fail every time, guaranteeing an overshoot
    // on the first clearance limit the train reaches (M2 on the SIMPLE_LOOP).
    const overshootInput = screen.getByRole('spinbutton', { name: /overshoot rate/i });
    await user.clear(overshootInput);
    await user.type(overshootInput, '1');

    await buildRoute(user, ['M1', 'M2', 'M3']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    // Pause auto-run so steps are the only source of virtual time advancement.
    await user.click(screen.getByRole('button', { name: /^pause$/i }));

    // Step enough virtual time for the train to cross M2 at speed. The
    // SIMPLE_LOOP edge is 200 mm at max 100 mm/s — roughly 2 s to traverse.
    // Six 1 s steps give comfortable headroom.
    for (let i = 0; i < 6; i++) {
      await user.click(screen.getByRole('button', { name: /^step 1s$/i }));
    }

    const anomalyMsg = client.published.find((m) =>
      m.topic.startsWith('railway/events/anomaly/T1'),
    );
    expect(anomalyMsg).toBeDefined();
    const envelope = JSON.parse(new TextDecoder().decode(anomalyMsg?.payload)) as {
      payload: { description: string };
    };
    expect(envelope.payload.description).toMatch(/overshot/i);
  });

  it('shows an empty-layout hint when the layout has no edges and Spawn is disabled', () => {
    renderControls(EDGELESS_LAYOUT);

    expect(screen.getByRole('button', { name: /spawn train/i })).toBeDisabled();
    expect(screen.getByText(/add at least one edge/i)).toBeInTheDocument();
  });

  it('does not show the empty-layout hint when the layout has edges', () => {
    renderControls();

    expect(screen.queryByText(/add at least one edge/i)).not.toBeInTheDocument();
  });

  it('shows a duplicate-id error and does not advance the counter when the operator re-uses a train ID', async () => {
    const user = userEvent.setup();
    renderControls();

    // Spawn T1 — succeeds, counter advances to T2.
    await buildRoute(user, ['M1', 'M2']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    const trainIdInput = screen.getByRole('textbox', { name: /train id/i });
    expect(trainIdInput).toHaveValue('T2');

    // Change back to T1 and try again (route stays the same — the operator
    // didn't touch it after spawning).
    await user.clear(trainIdInput);
    await user.type(trainIdInput, 'T1');
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    // Error appears; the counter has NOT advanced past T2.
    const errorEl = screen.getByRole('alert');
    expect(errorEl).toHaveTextContent(/T1 already exists/i);
    expect(trainIdInput).toHaveValue('T1');
  });

  it('clears the duplicate-id error after the operator fixes the ID and spawns successfully', async () => {
    const user = userEvent.setup();
    renderControls();

    // Cause the error.
    await buildRoute(user, ['M1', 'M2']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    const trainIdInput = screen.getByRole('textbox', { name: /train id/i });
    await user.clear(trainIdInput);
    await user.type(trainIdInput, 'T1');
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Fix the ID to a fresh one and spawn again.
    await user.clear(trainIdInput);
    await user.type(trainIdInput, 'T2');
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
