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
    /* Both real main-line junctions (Jloop at M-main-w, Jspur at M-spur) are drawn. */
    expect(screen.getAllByTestId('branching-junction').length).toBe(2);
    /* The two station platforms (CENTRAL, HILLSIDE) and the CV gantry are drawn. */
    expect(screen.getByTestId('station-central')).toBeTruthy();
    expect(screen.getByTestId('station-hillside')).toBeTruthy();
    expect(screen.getByTestId('yard-gantry')).toBeTruthy();

    await waitFor(() => {
      /* Four locos + their rakes + the gold spares cut render as bodies, and the
       *  world handle is exposed under the `branching` name. */
      expect(document.querySelectorAll('[data-body-id]').length).toBeGreaterThan(10);
      expect(window.__tfPhysics?.name).toBe('branching');
    });

    const ids = window.__tfPhysics?.bodies().map((b) => b.id) ?? [];
    expect(ids).toContain('T1');
    expect(ids).toContain('T2');
    expect(ids).toContain('T3');
    expect(ids).toContain('T4');
    expect(ids).toContain('g0');
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
