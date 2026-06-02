import { type Page, expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey for the route-builder. The form no longer hardcodes a
 * demo route — the operator picks each marker in order, with the dropdown
 * narrowing to the reachable onward markers after each pick. We assert the
 * train then visits exactly the markers the operator picked, by watching
 * the visualiser as edges advance.
 */

const BRANCHED: Layout = {
  name: 'operator-built-route',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'block_boundary' },
    { id: 'M4', kind: 'block_boundary' },
    { id: 'M5', kind: 'block_boundary' },
  ],
  // Two branches sharing M2: the natural slice-the-first-three-edges route
  // would have walked M1→M2, M2→M3, M3→M4. The operator picks the M2→M5
  // branch instead so the assertion can tell which path the train took.
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M5', estimated_length_mm: 200 },
  ],
  junctions: [],
};

async function buildRoute(sim: Page, path: ReadonlyArray<string>): Promise<void> {
  for (const marker of path) {
    await sim.getByLabel(/marker/i).selectOption(marker);
    await sim.getByRole('button', { name: /add to route/i }).click();
  }
}

test.describe
  .serial('Operator builds a route marker by marker', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: BRANCHED, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('the train takes the branch the operator picked, not a hardcoded slice', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, { layout: BRANCHED });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();

      // Operator builds M1 → M2 → M5 step by step. Spawn must be disabled
      // until the route has at least one edge (two markers).
      await expect(sim.getByRole('button', { name: /spawn train/i })).toBeDisabled();
      await buildRoute(sim, ['M1']);
      await expect(sim.getByRole('button', { name: /spawn train/i })).toBeDisabled();
      await buildRoute(sim, ['M2', 'M5']);
      await expect(sim.getByRole('button', { name: /spawn train/i })).toBeEnabled();

      // The visible planned-route list reflects the operator's clicks.
      await expect(sim.getByRole('list', { name: /planned route/i })).toHaveText(/M1.*M2.*M5/);

      await sim.getByRole('button', { name: /spawn train/i }).click();
      await expect(visualiser.locator('[data-train-id="T1"]')).toBeVisible({ timeout: 8_000 });

      // The branch from M2 has M5 as its destination — the train must reach
      // an edge or marker exclusive to that branch within the test window.
      const ON_BRANCH = new Set(['M2->M5', 'M5']);
      await expect
        .poll(
          async () => {
            const el = visualiser.locator('[data-train-id="T1"]');
            const onEdge = await el.getAttribute('data-on-edge');
            const atMarker = await el.getAttribute('data-at-marker');
            return (
              (onEdge !== null && ON_BRANCH.has(onEdge)) ||
              (atMarker !== null && ON_BRANCH.has(atMarker))
            );
          },
          {
            timeout: 20_000,
            message: 'expected T1 to reach an edge/marker exclusive to the M2→M5 branch',
          },
        )
        .toBe(true);

      // Conversely the train must NOT have ended up on the M3/M4 branch.
      const onEdge = await visualiser.locator('[data-train-id="T1"]').getAttribute('data-on-edge');
      const atMarker = await visualiser
        .locator('[data-train-id="T1"]')
        .getAttribute('data-at-marker');
      const positionalChecks = [onEdge, atMarker].filter((v): v is string => v !== null);
      for (const p of positionalChecks) {
        expect(['M2->M3', 'M3->M4', 'M3', 'M4']).not.toContain(p);
      }
    });
  });
