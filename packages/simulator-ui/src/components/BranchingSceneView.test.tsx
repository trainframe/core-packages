import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BranchingSceneView } from './BranchingSceneView.js';

describe('BranchingSceneView', () => {
  afterEach(() => {
    window.__tfPhysics = undefined;
    window.__tfLoadBranching = undefined;
    window.__tfFitView = undefined;
  });

  it('renders the branching track, junctions, stations, the yard gantry, the trains, and the live world handle', async () => {
    render(<BranchingSceneView />);
    expect(screen.getByTestId('physics-canvas')).toBeTruthy();
    expect(screen.getByTestId('physics-title').textContent).toContain('Branching layout');
    /* The one main-line junction (Jspur at M-spur) is drawn; the yard is in-line
     *  (a zone on the running line), not a tap junction. */
    expect(screen.getAllByTestId('branching-junction').length).toBe(1);
    /* The two station platforms (CENTRAL, HILLSIDE) and the CV gantry are drawn. */
    expect(screen.getByTestId('station-central')).toBeTruthy();
    expect(screen.getByTestId('station-hillside')).toBeTruthy();
    expect(screen.getByTestId('yard-gantry')).toBeTruthy();

    await waitFor(() => {
      /* The real demo world: three locos + their rakes (two cars each) + the
       *  two-carriage spares cut render as bodies — eleven in all — and the world
       *  handle is exposed under the `branching` name. */
      expect(document.querySelectorAll('[data-body-id]').length).toBeGreaterThanOrEqual(10);
      expect(window.__tfPhysics?.name).toBe('branching');
    });

    const ids = window.__tfPhysics?.bodies().map((b) => b.id) ?? [];
    expect(ids).toContain('T1');
    expect(ids).toContain('T2');
    expect(ids).toContain('T4');
    expect(ids).toContain('spare0');
  });

  it('exposes the DEV hooks the render script calls before scheduling', () => {
    render(<BranchingSceneView />);
    expect(typeof window.__tfLoadBranching).toBe('function');
    expect(typeof window.__tfFitView).toBe('function');
    /* Calling them must not throw (reseed nonce bump + no-op fit). */
    expect(() => act(() => window.__tfLoadBranching?.())).not.toThrow();
    expect(() => window.__tfFitView?.()).not.toThrow();
  });
});
