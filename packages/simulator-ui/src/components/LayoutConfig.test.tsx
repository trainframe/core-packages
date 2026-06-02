import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Layout } from '@trainframe/protocol';
import { describe, expect, it, vi } from 'vitest';
import { loadLayoutSelection } from '../config/layout-config.js';
import { LayoutConfig } from './LayoutConfig.js';

const VALID_CUSTOM_LAYOUT = JSON.stringify(
  {
    name: 'one-edge',
    markers: [
      { id: 'A', kind: 'block_boundary' },
      { id: 'B', kind: 'block_boundary' },
    ],
    edges: [{ from_marker_id: 'A', to_marker_id: 'B' }],
    junctions: [],
  },
  null,
  2,
);

describe('LayoutConfig', () => {
  it('shows the preset selector with the current preset selected', () => {
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );

    const dropdown = screen.getByLabelText(/source/i) as HTMLSelectElement;
    expect(dropdown.value).toBe('simple-loop');
  });

  it('persists and reports a preset switch when the user applies it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={onChange} />,
    );

    await user.selectOptions(screen.getByLabelText(/source/i), 'long-loop');
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    expect(onChange).toHaveBeenCalledWith({ kind: 'preset', preset_id: 'long-loop' });
    expect(loadLayoutSelection()).toEqual({ kind: 'preset', preset_id: 'long-loop' });
  });

  it('reveals the JSON textarea when Custom is selected', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );

    expect(screen.queryByLabelText(/layout json/i)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/source/i), 'custom');
    expect(screen.getByLabelText(/layout json/i)).toBeInTheDocument();
  });

  it('saves a valid custom layout and reports it via onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={onChange} />,
    );

    await user.selectOptions(screen.getByLabelText(/source/i), 'custom');
    const textarea = screen.getByLabelText(/layout json/i);
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(VALID_CUSTOM_LAYOUT);
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0]?.[0];
    expect(call).toMatchObject({ kind: 'custom' });
    expect((call as { layout: { name: string } }).layout.name).toBe('one-edge');
    expect(loadLayoutSelection()).toMatchObject({ kind: 'custom' });
  });

  it('shows an error and does NOT call onChange when JSON is invalid', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={onChange} />,
    );

    await user.selectOptions(screen.getByLabelText(/source/i), 'custom');
    const textarea = screen.getByLabelText(/layout json/i);
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste('not json');
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/invalid json/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows an error when the JSON is structurally wrong', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={onChange} />,
    );

    await user.selectOptions(screen.getByLabelText(/source/i), 'custom');
    const textarea = screen.getByLabelText(/layout json/i);
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(JSON.stringify({ name: 'no-arrays' }));
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('LayoutConfig — Build mode', () => {
  async function enterBuildMode(user: ReturnType<typeof userEvent.setup>) {
    await user.selectOptions(screen.getByLabelText(/source/i), 'build');
  }

  it('reveals the Track builder form when Build is selected', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );

    expect(screen.queryByRole('group', { name: /markers/i })).not.toBeInTheDocument();
    await enterBuildMode(user);

    expect(screen.getByRole('group', { name: /markers/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /edges/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /junctions/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/layout name/i)).toHaveValue('my-track');
  });

  it('adds a marker to the list when the operator submits the marker form', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );
    await enterBuildMode(user);

    await user.type(screen.getByLabelText(/^marker id/i), 'M1');
    await user.selectOptions(screen.getByLabelText(/^kind/i), 'station_stop');
    await user.click(screen.getByRole('button', { name: /add marker/i }));

    const markersList = screen.getByRole('list', { name: /markers/i });
    expect(markersList).toHaveTextContent(/M1/);
    expect(markersList).toHaveTextContent(/station_stop/);
  });

  it('removes a marker when the row Remove button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );
    await enterBuildMode(user);

    await user.type(screen.getByLabelText(/^marker id/i), 'M1');
    await user.click(screen.getByRole('button', { name: /add marker/i }));
    expect(screen.getByRole('list', { name: /markers/i })).toHaveTextContent(/M1/);

    await user.click(screen.getByRole('button', { name: /remove marker m1/i }));
    expect(screen.getByRole('list', { name: /markers/i })).not.toHaveTextContent(/M1/);
  });

  it('adds an edge between two markers and lists it', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );
    await enterBuildMode(user);

    for (const id of ['M1', 'M2']) {
      await user.clear(screen.getByLabelText(/^marker id/i));
      await user.type(screen.getByLabelText(/^marker id/i), id);
      await user.click(screen.getByRole('button', { name: /add marker/i }));
    }

    await user.selectOptions(screen.getByLabelText(/^from marker/i), 'M1');
    await user.selectOptions(screen.getByLabelText(/^to marker/i), 'M2');
    await user.click(screen.getByRole('button', { name: /add edge/i }));

    const edgesList = screen.getByRole('list', { name: /edges/i });
    expect(edgesList).toHaveTextContent(/M1.*M2/);
  });

  it('rejects a self-edge (from === to) with an inline alert', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );
    await enterBuildMode(user);

    await user.type(screen.getByLabelText(/^marker id/i), 'M1');
    await user.click(screen.getByRole('button', { name: /add marker/i }));

    await user.selectOptions(screen.getByLabelText(/^from marker/i), 'M1');
    await user.selectOptions(screen.getByLabelText(/^to marker/i), 'M1');
    await user.click(screen.getByRole('button', { name: /add edge/i }));

    const edgeAlert = within(screen.getByRole('group', { name: /edges/i })).getByRole('alert');
    expect(edgeAlert).toHaveTextContent(/self/i);
  });

  it('rejects duplicate edges with an inline alert', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );
    await enterBuildMode(user);

    for (const id of ['M1', 'M2']) {
      await user.clear(screen.getByLabelText(/^marker id/i));
      await user.type(screen.getByLabelText(/^marker id/i), id);
      await user.click(screen.getByRole('button', { name: /add marker/i }));
    }
    await user.selectOptions(screen.getByLabelText(/^from marker/i), 'M1');
    await user.selectOptions(screen.getByLabelText(/^to marker/i), 'M2');
    await user.click(screen.getByRole('button', { name: /add edge/i }));

    await user.selectOptions(screen.getByLabelText(/^from marker/i), 'M1');
    await user.selectOptions(screen.getByLabelText(/^to marker/i), 'M2');
    await user.click(screen.getByRole('button', { name: /add edge/i }));

    const edgeAlert = within(screen.getByRole('group', { name: /edges/i })).getByRole('alert');
    expect(edgeAlert).toHaveTextContent(/duplicate/i);
  });

  it('only lists junction-kind markers in the junction marker select', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );
    await enterBuildMode(user);

    await user.type(screen.getByLabelText(/^marker id/i), 'M1');
    await user.click(screen.getByRole('button', { name: /add marker/i }));
    await user.clear(screen.getByLabelText(/^marker id/i));
    await user.type(screen.getByLabelText(/^marker id/i), 'J1');
    await user.selectOptions(screen.getByLabelText(/^kind/i), 'junction');
    await user.click(screen.getByRole('button', { name: /add marker/i }));

    const junctionSelect = screen.getByLabelText(/^junction marker/i) as HTMLSelectElement;
    const optionValues = Array.from(junctionSelect.options).map((opt) => opt.value);
    expect(optionValues).toContain('J1');
    expect(optionValues).not.toContain('M1');
  });

  it('adds a junction with the default positions and lists it', async () => {
    const user = userEvent.setup();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={() => {}} />,
    );
    await enterBuildMode(user);

    await user.type(screen.getByLabelText(/^marker id/i), 'J1');
    await user.selectOptions(screen.getByLabelText(/^kind/i), 'junction');
    await user.click(screen.getByRole('button', { name: /add marker/i }));

    await user.selectOptions(screen.getByLabelText(/^junction marker/i), 'J1');
    await user.click(screen.getByRole('button', { name: /add junction/i }));

    expect(screen.getByRole('list', { name: /junctions/i })).toHaveTextContent(/J1/);
  });

  it('applies a valid built layout and calls onChange with kind=custom', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={onChange} />,
    );
    await enterBuildMode(user);

    await user.clear(screen.getByLabelText(/layout name/i));
    await user.type(screen.getByLabelText(/layout name/i), 'built-track');

    for (const id of ['M1', 'M2']) {
      await user.clear(screen.getByLabelText(/^marker id/i));
      await user.type(screen.getByLabelText(/^marker id/i), id);
      await user.click(screen.getByRole('button', { name: /add marker/i }));
    }

    await user.selectOptions(screen.getByLabelText(/^from marker/i), 'M1');
    await user.selectOptions(screen.getByLabelText(/^to marker/i), 'M2');
    await user.click(screen.getByRole('button', { name: /add edge/i }));

    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0]?.[0] as { kind: string; layout: Layout };
    expect(call.kind).toBe('custom');
    expect(call.layout.name).toBe('built-track');
    expect(call.layout.markers.map((m) => m.id)).toEqual(['M1', 'M2']);
    expect(call.layout.edges).toEqual([{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
    expect(loadLayoutSelection()).toMatchObject({ kind: 'custom' });
  });

  it('surfaces a referential-integrity error when an edge dangles after a marker is removed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <LayoutConfig selection={{ kind: 'preset', preset_id: 'simple-loop' }} onChange={onChange} />,
    );
    await enterBuildMode(user);

    for (const id of ['M1', 'M2']) {
      await user.clear(screen.getByLabelText(/^marker id/i));
      await user.type(screen.getByLabelText(/^marker id/i), id);
      await user.click(screen.getByRole('button', { name: /add marker/i }));
    }
    await user.selectOptions(screen.getByLabelText(/^from marker/i), 'M1');
    await user.selectOptions(screen.getByLabelText(/^to marker/i), 'M2');
    await user.click(screen.getByRole('button', { name: /add edge/i }));

    await user.click(screen.getByRole('button', { name: /remove marker m2/i }));
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    expect(screen.getByTestId('layout-error')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('prefills Build forms from the current custom selection on entry', async () => {
    const user = userEvent.setup();
    const selection = {
      kind: 'custom' as const,
      layout: {
        name: 'preexisting',
        markers: [
          { id: 'X1', kind: 'block_boundary' as const },
          { id: 'X2', kind: 'station_stop' as const },
        ],
        edges: [{ from_marker_id: 'X1', to_marker_id: 'X2' }],
        junctions: [],
      },
    };
    render(<LayoutConfig selection={selection} onChange={() => {}} />);

    await enterBuildMode(user);

    expect(screen.getByLabelText(/layout name/i)).toHaveValue('preexisting');
    const markersList = screen.getByRole('list', { name: /markers/i });
    expect(markersList).toHaveTextContent(/X1/);
    expect(markersList).toHaveTextContent(/X2/);
    const edgesList = screen.getByRole('list', { name: /edges/i });
    expect(edgesList).toHaveTextContent(/X1.*X2/);
  });
});
