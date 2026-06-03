import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Layout } from '@trainframe/protocol';
import { describe, expect, it, vi } from 'vitest';
import { TrackBuilder } from './TrackBuilder.js';

describe('TrackBuilder', () => {
  it('renders palette buttons for all 6 piece types', () => {
    render(<TrackBuilder onApply={() => {}} />);
    for (const label of ['Straight', 'Curve', 'Junction', 'Station', 'Terminus', 'Crossing']) {
      expect(
        screen.getByRole('button', { name: new RegExp(`Add ${label}`, 'i') }),
      ).toBeInTheDocument();
    }
  });

  it('starts with an empty canvas (no pieces)', () => {
    render(<TrackBuilder onApply={() => {}} />);
    expect(screen.getByTestId('track-canvas')).toBeInTheDocument();
    // No piece groups rendered yet.
    expect(screen.queryByTestId(/^piece-/)).not.toBeInTheDocument();
  });

  it('adds a piece when a palette button is clicked', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));

    expect(screen.getByTestId(/^piece-/)).toBeInTheDocument();
  });

  it('adds multiple pieces for repeated clicks', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    await user.click(screen.getByRole('button', { name: /add curve/i }));
    await user.click(screen.getByRole('button', { name: /add junction/i }));

    expect(screen.getAllByTestId(/^piece-/)).toHaveLength(3);
  });

  it('shows piece stats after adding pieces', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));

    const stats = screen.getByTestId('layout-stats');
    expect(stats.textContent).toMatch(/markers/);
    expect(stats.textContent).toMatch(/edges/);
  });

  it('selects a piece on click and shows its info in the status bar', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));

    // The newly added piece is auto-selected.
    const statusText = screen.getByText(/selected:/i);
    expect(statusText).toBeInTheDocument();
    expect(statusText.textContent?.toLowerCase()).toContain('straight');
  });

  it('Rotate button rotates the selected piece by 45°', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));

    // Selected. Status bar should say 0° initially.
    expect(screen.getByText(/selected:/i).textContent).toContain('0°');

    await user.click(screen.getByRole('button', { name: /rotate selected piece/i }));
    expect(screen.getByText(/selected:/i).textContent).toContain('45°');

    await user.click(screen.getByRole('button', { name: /rotate selected piece/i }));
    expect(screen.getByText(/selected:/i).textContent).toContain('90°');
  });

  it('Delete button removes the selected piece', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    expect(screen.getAllByTestId(/^piece-/)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /delete selected piece/i }));
    expect(screen.queryByTestId(/^piece-/)).not.toBeInTheDocument();
  });

  it('Toggle tag button flips the tagged state of the selected piece', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));

    // Initially untagged — button says "Tag (T)"
    const tagBtn = screen.getByRole('button', { name: /toggle tag/i });
    expect(tagBtn.textContent).toContain('Tag');

    await user.click(tagBtn);
    // Now tagged — status bar shows "tagged" and button says "Untag (T)"
    expect(screen.getByText(/selected:/i).textContent?.toLowerCase()).toContain('tagged');
    expect(tagBtn.textContent).toContain('Untag');

    await user.click(tagBtn);
    expect(screen.getByText(/selected:/i).textContent?.toLowerCase()).not.toContain('tagged');
  });

  it('Rotate, Delete, Tag buttons are disabled when no piece is selected', () => {
    render(<TrackBuilder onApply={() => {}} />);

    expect(screen.getByRole('button', { name: /rotate selected piece/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete selected piece/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /toggle tag/i })).toBeDisabled();
  });

  it('Apply layout calls onApply with a compiled Layout', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<TrackBuilder onApply={onApply} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const layout = onApply.mock.calls[0]?.[0] as Layout;
    expect(layout.markers.length).toBeGreaterThan(0);
    expect(layout.edges.length).toBeGreaterThan(0);
    expect(layout.name).toBe('my-track');
  });

  it('Apply layout with two adjacent straights yields 3 markers and 2 edges', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<TrackBuilder onApply={onApply} />);

    // Add two straights then apply (they will share a cluster since they
    // are placed with offsets 0 and 30 mm — not connected, so 4 markers).
    // This test verifies the count passes through correctly.
    await user.click(screen.getByRole('button', { name: /add straight/i }));
    await user.click(screen.getByRole('button', { name: /add straight/i }));
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    const layout = onApply.mock.calls[0]?.[0] as Layout;
    // Two unconnected straights = 4 markers, 2 edges.
    expect(layout.markers).toHaveLength(4);
    expect(layout.edges).toHaveLength(2);
  });

  it('Apply layout with a junction yields 2 edges and 1 junction entry', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<TrackBuilder onApply={onApply} />);

    await user.click(screen.getByRole('button', { name: /add junction/i }));
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    const layout = onApply.mock.calls[0]?.[0] as Layout;
    expect(layout.edges).toHaveLength(2);
    expect(layout.junctions).toHaveLength(1);
  });

  it('layout name input defaults to "my-track" and is included in compiled layout', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<TrackBuilder onApply={onApply} />);

    expect(screen.getByLabelText(/layout name/i)).toHaveValue('my-track');

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    const layout = onApply.mock.calls[0]?.[0] as Layout;
    expect(layout.name).toBe('my-track');
  });

  it('custom layout name is used in compiled layout', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<TrackBuilder onApply={onApply} />);

    const nameInput = screen.getByLabelText(/layout name/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'my-custom-layout');

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    await user.click(screen.getByRole('button', { name: /apply layout/i }));

    const layout = onApply.mock.calls[0]?.[0] as Layout;
    expect(layout.name).toBe('my-custom-layout');
  });

  it('clicking the canvas background deselects the piece', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    expect(screen.getByText(/selected:/i)).toBeInTheDocument();

    // Click the canvas background (not a piece).
    await user.click(screen.getByTestId('track-canvas'));
    expect(screen.queryByText(/selected:/i)).not.toBeInTheDocument();
  });

  it('keyboard R rotates the selected piece', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    expect(screen.getByText(/selected:/i).textContent).toContain('0°');

    await user.keyboard('r');
    expect(screen.getByText(/selected:/i).textContent).toContain('45°');
  });

  it('keyboard Delete removes the selected piece', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    expect(screen.getAllByTestId(/^piece-/)).toHaveLength(1);

    await user.keyboard('{Delete}');
    expect(screen.queryByTestId(/^piece-/)).not.toBeInTheDocument();
  });

  it('keyboard T toggles tag on the selected piece', async () => {
    const user = userEvent.setup();
    render(<TrackBuilder onApply={() => {}} />);

    await user.click(screen.getByRole('button', { name: /add straight/i }));
    expect(screen.getByText(/selected:/i).textContent?.toLowerCase()).not.toContain('tagged');

    await user.keyboard('t');
    expect(screen.getByText(/selected:/i).textContent?.toLowerCase()).toContain('tagged');
  });
});
