import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PhysicsScenarioView } from './PhysicsScenarioView.js';

describe('PhysicsScenarioView', () => {
  afterEach(() => {
    window.__tfPhysics = undefined;
  });

  it('renders a known scenario: pieces, bodies, and the live world handle', async () => {
    render(<PhysicsScenarioView name="collision" />);
    expect(screen.getByTestId('physics-canvas')).toBeTruthy();
    expect(screen.getByTestId('physics-title').textContent).toContain('collide');
    // The two locos render as bodies, and the world handle is exposed.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-body-id]').length).toBe(2);
      expect(window.__tfPhysics?.name).toBe('collision');
    });
    expect(
      window.__tfPhysics
        ?.bodies()
        .map((b) => b.id)
        .sort(),
    ).toEqual(['blue', 'red']);
  });

  it('renders a fallback for an unknown scenario', () => {
    render(<PhysicsScenarioView name="does-not-exist" />);
    expect(screen.getByText(/Unknown physics scenario/)).toBeTruthy();
  });

  it('mounts the vision station scenario: overlay + live handle', async () => {
    render(<PhysicsScenarioView name="vision" />);
    expect(screen.getByTestId('vision-overlay')).toBeTruthy();
    expect(screen.getByTestId('vision-readout')).toBeTruthy();
    // The vision handle initialises with the expected (calibrated) length even
    // before the rake has cleared. (The full measurement is asserted by the
    // sensors unit tests and the video harness — kept out of this fast render test.)
    await waitFor(() => {
      expect(window.__tfVision?.expectedMm).toBe(224);
    });
  });
});
