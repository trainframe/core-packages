import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
