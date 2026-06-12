import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SpectacleScenarioView } from './SpectacleScenarioView.js';

describe('SpectacleScenarioView', () => {
  afterEach(() => {
    window.__tfPhysics = undefined;
  });

  it('renders the curved/split track, the junction, the trains, and the live world handle', async () => {
    render(<SpectacleScenarioView />);
    expect(screen.getByTestId('physics-canvas')).toBeTruthy();
    expect(screen.getByTestId('physics-title').textContent).toContain('Spectacle');
    expect(screen.getByTestId('spectacle-junction')).toBeTruthy();
    await waitFor(() => {
      /* Three locos + their carriages + the gold spare cut render as bodies, and
       *  the world handle is exposed under the spectacle name. */
      expect(document.querySelectorAll('[data-body-id]').length).toBeGreaterThan(10);
      expect(window.__tfPhysics?.name).toBe('spectacle');
    });
    const ids = window.__tfPhysics?.bodies().map((b) => b.id) ?? [];
    expect(ids).toContain('LA');
    expect(ids).toContain('LB');
    expect(ids).toContain('LC');
    expect(ids).toContain('g0');
  });
});
