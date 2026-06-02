import { type Browser, expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { SIM_URL, VISUALISER_URL } from '../playwright.config.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey: spawn several trains, run the sim, watch the visualiser.
 *
 * Written from the user's POV — every assertion is something the operator can
 * see on screen. Encodes the regression for the block exclusivity release
 * (cleared edges must be pruned as a train traverses, otherwise following
 * trains sit at M1 forever).
 */

const SIMPLE_LOOP: Layout = {
  name: 'multi-train-journey',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
    { id: 'M4', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

const openVisualiser = async (browser: Browser) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() =>
    localStorage.setItem('trainframe.visualiser.brokerUrl', 'ws://127.0.0.1:9001'),
  );
  const page = await ctx.newPage();
  await page.goto(VISUALISER_URL);
  return page;
};

const openSimulatorUi = async (browser: Browser, layout: Layout) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ({ broker, selection }) => {
      localStorage.setItem('trainframe.simulator-ui.brokerUrl', broker);
      localStorage.setItem('trainframe.simulator-ui.layout', selection);
    },
    {
      broker: 'ws://127.0.0.1:9001',
      selection: JSON.stringify({ kind: 'custom', layout }),
    },
  );
  const page = await ctx.newPage();
  await page.goto(SIM_URL);
  return page;
};

test.describe
  .serial('Multi-train operator journey', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: SIMPLE_LOOP, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('three trains spawned in succession all advance past the start', async ({ browser }) => {
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, SIMPLE_LOOP);

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();

      // Operator builds a route (M1 → M2 → M3 → M4) once. The route stays
      // in the form across spawns so each new train gets the same plan.
      for (const marker of ['M1', 'M2', 'M3', 'M4']) {
        await sim.getByLabel(/marker/i).selectOption(marker);
        await sim.getByRole('button', { name: /add to route/i }).click();
      }

      // Operator drives the lifecycle with three Spawn clicks. Spawn auto-
      // starts AND auto-resumes the sim; the form's Train ID auto-increments,
      // so we fill it explicitly to keep the test deterministic across renders.
      for (const id of ['T1', 'T2', 'T3']) {
        await sim.getByLabel(/^Train ID/i).fill(id);
        await sim.getByRole('button', { name: /Spawn train/i }).click();
      }

      // All three trains must appear on the visualiser canvas.
      for (const id of ['T1', 'T2', 'T3']) {
        await expect(visualiser.locator(`[data-train-id="${id}"]`)).toBeVisible({ timeout: 8_000 });
      }

      // Block-exclusivity regression: every train must eventually leave the
      // first edge (M1→M2). In the buggy world T1 advances and T2/T3 sit on
      // M1→M2 forever because T1 never releases the block. In the fixed world
      // T2 and T3 queue behind T1 and all three end up on later edges.
      await expect
        .poll(
          async () => {
            const positions = await visualiser
              .locator('[data-train-id]')
              .evaluateAll((els) =>
                els.map(
                  (el) => el.getAttribute('data-at-marker') ?? el.getAttribute('data-on-edge'),
                ),
              );
            return positions.length === 3 && positions.every((p) => p !== null && p !== 'M1->M2');
          },
          {
            timeout: 15_000,
            message: 'expected every train to leave the first edge (M1→M2)',
          },
        )
        .toBe(true);
    });
  });
