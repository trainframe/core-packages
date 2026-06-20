import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as adminClient from '../api/admin-client.js';
import { MaintenancePanel } from './MaintenancePanel.js';

describe('MaintenancePanel', () => {
  it('prunes orphan markers and reports the result', async () => {
    vi.spyOn(adminClient, 'pruneMarkers').mockResolvedValue(['ORPHAN-A', 'ORPHAN-B']);
    render(<MaintenancePanel adminApiUrl="http://h:3000" />);
    fireEvent.click(screen.getByRole('button', { name: /prune/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/2 marker/i));
  });

  it('requires the typed phrase before blank-slate', () => {
    const reset = vi.spyOn(adminClient, 'resetState').mockResolvedValue({ topics_cleared: 0 });
    render(<MaintenancePanel adminApiUrl="http://h:3000" />);
    fireEvent.click(screen.getByRole('button', { name: /blank slate/i }));
    expect(screen.getByRole('button', { name: /confirm/i })).toBeDisabled();
    expect(reset).not.toHaveBeenCalled();
  });

  it('surfaces prune errors via alert', async () => {
    vi.spyOn(adminClient, 'pruneMarkers').mockRejectedValue(new Error('boom'));
    render(<MaintenancePanel adminApiUrl="http://h:3000" />);
    fireEvent.click(screen.getByRole('button', { name: /prune/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('boom');
  });
});
