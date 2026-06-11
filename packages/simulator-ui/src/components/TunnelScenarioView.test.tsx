/**
 * Render-level coverage of the tunnel scenario view: it mounts, runs its rAF
 * loop, draws the portal/roof/marker furniture, and exposes the live
 * `window.__tfPhysics` handle the harness reads (the fired markers + the
 * camera-saw-inside flag). The full sensing/physics behaviour is asserted in the
 * headless `physics/tunnel*` unit tests; this proves the React shell is wired.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TunnelScenarioView } from './TunnelScenarioView.js';

describe('TunnelScenarioView', () => {
  afterEach(() => {
    window.__tfPhysics = undefined;
  });

  it('mounts the dark tunnel: portals, roof, markers, and the live handle', async () => {
    render(<TunnelScenarioView />);
    expect(screen.getByTestId('physics-canvas')).toBeTruthy();
    expect(screen.getAllByTestId('tunnel-portal').length).toBe(2);
    expect(screen.getByTestId('tunnel-roof')).toBeTruthy();
    expect(screen.getByTestId('tunnel-marker-entry')).toBeTruthy();
    expect(screen.getByTestId('tunnel-marker-exit')).toBeTruthy();
    expect(screen.getByTestId('physics-title').textContent).toContain('dark');
    await waitFor(() => {
      expect(window.__tfPhysics?.name).toBe('tunnel');
      expect(window.__tfPhysics?.cameraSawInside).toBe(false);
    });
    // The loco renders as a body.
    expect(document.querySelector('[data-body-id="T"]')).toBeTruthy();
  });

  it('mounts the lit tunnel and exposes its name + glow', async () => {
    render(<TunnelScenarioView lit={true} />);
    expect(screen.getByTestId('tunnel-lit-glow')).toBeTruthy();
    expect(screen.getByTestId('physics-title').textContent).toContain('lit');
    await waitFor(() => {
      expect(window.__tfPhysics?.name).toBe('tunnel-lit');
    });
  });
});
