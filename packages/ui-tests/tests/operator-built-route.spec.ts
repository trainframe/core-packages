import { type Page, expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey for the schedule builder. The operator picks stops the
 * train will cycle through; the planner computes the per-leg transit through
 * the layout graph on demand (ADR-010). We assert the train visits the branch
 * the operator selected by watching the visualiser as edges advance.
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
  // Two branches sharing M2: M1→M2→M3→M4→M1 and M1→M2→M5→M1. The operator
  // picks M5 as a stop so the planner routes M1→M2→M5, exercising the branch
  // that a trivial first-edge walk would never take. Both branches loop back
  // to M1 so cyclic schedules can resolve their return leg.
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M5', estimated_length_mm: 200 },
    { from_marker_id: 'M5', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

/** Pick each stop ID in order and click Add stop. */
async function buildSchedule(sim: Page, stops: ReadonlyArray<string>): Promise<void> {
  for (const stop of stops) {
    await sim.getByRole('combobox', { name: /stop/i }).selectOption(stop);
    await sim.getByRole('button', { name: /add stop/i }).click();
  }
}

test.describe
  .serial('Operator builds a schedule by picking stops', () => {
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

      // Operator picks M1 as the first stop (spawn marker) and M5 as the
      // second stop. Spawn is enabled as soon as there is at least one stop.
      await expect(sim.getByRole('button', { name: /spawn train/i })).toBeDisabled();
      await buildSchedule(sim, ['M1']);
      await expect(sim.getByRole('button', { name: /spawn train/i })).toBeEnabled();
      await buildSchedule(sim, ['M5']);
      await expect(sim.getByRole('button', { name: /spawn train/i })).toBeEnabled();

      // The visible planned-stops list reflects the operator's clicks.
      await expect(sim.getByRole('list', { name: /planned stops/i })).toHaveText(/M1.*M5/);

      // Spawn the train. The planner computes M1→M2→M5 from the two stops.
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
