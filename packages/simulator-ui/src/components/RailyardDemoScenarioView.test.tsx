import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RailyardDemoScenarioView } from './RailyardDemoScenarioView.js';

describe('RailyardDemoScenarioView', () => {
  afterEach(() => {
    window.__tfPhysics = undefined;
  });

  it('renders the curved/split track, the junction, the trains, and the live world handle', async () => {
    render(<RailyardDemoScenarioView />);
    expect(screen.getByTestId('physics-canvas')).toBeTruthy();
    expect(screen.getByTestId('physics-title').textContent).toContain('Railyard demo');
    expect(screen.getByTestId('railyard-junction')).toBeTruthy();
    await waitFor(() => {
      /* Five locos + their carriages + the gold spare cut render as bodies, and
       *  the world handle is exposed under the railyard-demo name. */
      expect(document.querySelectorAll('[data-body-id]').length).toBeGreaterThan(10);
      expect(window.__tfPhysics?.name).toBe('railyard-demo');
    });
    const ids = window.__tfPhysics?.bodies().map((b) => b.id) ?? [];
    expect(ids).toContain('LA');
    expect(ids).toContain('LB');
    expect(ids).toContain('LC');
    expect(ids).toContain('LD');
    expect(ids).toContain('g0');
  });
});
