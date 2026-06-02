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

/** A layout with no markers — represents the "empty layout" edge case. */
const EMPTY_LAYOUT: Layout = {
  name: 'empty',
  markers: [],
  edges: [],
  junctions: [],
};

/**
 * Build a schedule by selecting each marker in `stops` from the dropdown and
 * clicking "Add stop". Mirrors how a real operator drives the panel: pick
 * which stations the train should visit, in order.
 */
async function buildSchedule(
  user: ReturnType<typeof userEvent.setup>,
  stops: ReadonlyArray<string>,
) {
  for (const marker of stops) {
    const dropdown = screen.getByRole('combobox', { name: /stop/i });
    await user.selectOptions(dropdown, marker);
    await user.click(screen.getByRole('button', { name: /add stop/i }));
  }
}

describe('SimControls — operator panel', () => {
  it('opens with no trains and Spawn disabled until a stop is picked', () => {
    renderControls();

    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /spawn train/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^pause$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeDisabled();
  });

  it('spawning a train surfaces it in the panel and registers it on the broker', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    // Schedule: spawn at M1 (the first stop is the spawn marker), then cycle
    // through M3 and back.
    await buildSchedule(user, ['M1', 'M3']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.getByText('T1')).toBeInTheDocument();
    const registered = client.published.find((m) =>
      m.topic.startsWith('railway/events/device_registered/T1'),
    );
    expect(registered).toBeDefined();
  });

  it('passes the operator-picked stops to the runner, the planner finds the path', async () => {
    const user = userEvent.setup();
    // A branched layout. From M2 the operator's stop list directs the train
    // toward M5 rather than the structural shortest path that wraps around.
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

    // Operator picks stops M1 → M5. The planner finds M1→M2→M5.
    await buildSchedule(user, ['M1', 'M5']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    // Pause auto-run, then step enough to traverse both edges.
    await user.click(screen.getByRole('button', { name: /^pause$/i }));
    for (let i = 0; i < 6; i++) {
      await user.click(screen.getByRole('button', { name: /^step 1s$/i }));
    }

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

    // The train must visit M5 (the operator's chosen stop) and not stray
    // onto the M3/M4 branch the planner could otherwise have picked from M2.
    expect(traversals).toContain('M5');
    expect(traversals).not.toContain('M3');
  });

  it('enables Spawn as soon as the first stop is picked — a single-stop schedule parks at it', async () => {
    const user = userEvent.setup();
    renderControls();

    const spawn = screen.getByRole('button', { name: /spawn train/i });
    expect(spawn).toBeDisabled();

    await buildSchedule(user, ['M1']);
    expect(spawn).toBeEnabled();
  });

  it('offers every layout marker as a stop, regardless of reachability', async () => {
    const user = userEvent.setup();
    renderControls();

    // Stops are operator intent, not a per-edge plan — the picker offers every
    // marker. Reachability is the planner's concern, not the operator's.
    const beforeOptions = (screen.getByRole('combobox', { name: /stop/i }) as HTMLSelectElement)
      .options;
    expect(
      Array.from(beforeOptions)
        .map((o) => o.value)
        .sort(),
    ).toEqual(['M1', 'M2', 'M3', 'M4']);

    await buildSchedule(user, ['M1']);

    // Still every marker — picking M1 as the first stop doesn't constrain
    // the next pick to "reachable in one edge."
    const afterOptions = (screen.getByRole('combobox', { name: /stop/i }) as HTMLSelectElement)
      .options;
    expect(
      Array.from(afterOptions)
        .map((o) => o.value)
        .sort(),
    ).toEqual(['M1', 'M2', 'M3', 'M4']);
  });

  it('Remove last truncates the stop list by one and Clear stops resets it', async () => {
    const user = userEvent.setup();
    renderControls();

    await buildSchedule(user, ['M1', 'M2', 'M3']);
    expect(screen.getByRole('list', { name: /planned stops/i })).toHaveTextContent(/M1.*M2.*M3/);

    await user.click(screen.getByRole('button', { name: /remove last/i }));
    expect(screen.getByRole('list', { name: /planned stops/i })).toHaveTextContent(/M1.*M2/);
    expect(screen.queryByRole('list', { name: /planned stops/i })).not.toHaveTextContent(/M3/);

    await user.click(screen.getByRole('button', { name: /clear stops/i }));
    expect(screen.queryByRole('list', { name: /planned stops/i })).not.toBeInTheDocument();
  });

  it('spawning from idle leaves the sim running so the train moves without extra clicks', async () => {
    const user = userEvent.setup();
    renderControls();

    await buildSchedule(user, ['M1', 'M2']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));

    expect(screen.getByTestId('sim-status')).toHaveTextContent('running');
  });

  it('stepping the sim after spawn produces marker_traversed events for the train', async () => {
    const user = userEvent.setup();
    const { client } = renderControls();

    await buildSchedule(user, ['M1', 'M3']);
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

    await buildSchedule(user, ['M1', 'M2']);
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

    // Schedule that plans M1→M2→M3. The clearance limit on the first leg
    // is M2 (the first intermediate marker the planner picks); overshoot
    // there.
    await buildSchedule(user, ['M1', 'M3']);
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

  it('shows an empty-layout hint when the layout has no markers and Spawn is disabled', () => {
    renderControls(EMPTY_LAYOUT);

    expect(screen.getByRole('button', { name: /spawn train/i })).toBeDisabled();
    expect(screen.getByText(/add at least one marker/i)).toBeInTheDocument();
  });

  it('does not show the empty-layout hint when the layout has markers', () => {
    renderControls();

    expect(screen.queryByText(/add at least one marker/i)).not.toBeInTheDocument();
  });

  it('shows a duplicate-id error and does not advance the counter when the operator re-uses a train ID', async () => {
    const user = userEvent.setup();
    renderControls();

    // Spawn T1 — succeeds, counter advances to T2.
    await buildSchedule(user, ['M1', 'M2']);
    await user.click(screen.getByRole('button', { name: /spawn train/i }));
    const trainIdInput = screen.getByRole('textbox', { name: /train id/i });
    expect(trainIdInput).toHaveValue('T2');

    // Change back to T1 and try again (stops list stays the same — the operator
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
    await buildSchedule(user, ['M1', 'M2']);
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
