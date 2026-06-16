import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InterestingRailwayDemoView } from './InterestingRailwayDemoView.js';

describe('InterestingRailwayDemoView', () => {
  afterEach(() => {
    window.__tfPhysics = undefined;
  });

  it('renders the interesting track + the four trains and exposes the live world handle', async () => {
    render(<InterestingRailwayDemoView />);
    expect(screen.getByTestId('physics-canvas')).toBeTruthy();
    expect(screen.getByTestId('physics-title').textContent).toContain('Interesting railway');

    await waitFor(() => {
      /* The real demo world: four locos + their rakes (two cars each) + the two-car
       *  spares cut render as bodies; the world handle is exposed under its name. */
      expect(document.querySelectorAll('[data-body-id]').length).toBeGreaterThanOrEqual(10);
      expect(window.__tfPhysics?.name).toBe('interesting-demo');
    });

    const ids = window.__tfPhysics?.bodies().map((b) => b.id) ?? [];
    expect(ids).toContain('T1');
    expect(ids).toContain('T4');
    expect(ids).toContain('spare0');
  });
});
