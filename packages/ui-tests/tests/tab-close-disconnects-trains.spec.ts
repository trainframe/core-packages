import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * When the operator closes the simulator-ui tab, Chromium fires the
 * `pagehide` event before tearing down the page. The `useSimRunner` hook
 * listens for that event and calls `runner.stop()`, which despawns each train
 * through the Simulation (emitting `device_disconnected`). The visualiser's
 * train-position and train-status hooks remove a train when they see that
 * event, so the icon disappears.
 *
 * Without the pagehide handler, closing the tab leaves trains visible in the
 * visualiser forever because no disconnect events are published.
 *
 * The test drives the journey as a real operator would: it opens both UIs,
 * spawns a train, and closes the simulator-ui page via Playwright's
 * `page.close()`. This is safe because Chromium dispatches `pagehide`
 * synchronously as part of the page-close sequence and the MQTT frame is
 * small enough to flush within that window before the WebSocket tears down.
 */

const CLOSE_LOOP: Layout = {
  name: 'tab-close-disconnects',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'block_boundary' },
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

test.describe
  .serial('Closing the simulator-ui tab removes trains from the visualiser', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: CLOSE_LOOP, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('closing the sim-ui context removes the train icon from the visualiser', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, { layout: CLOSE_LOOP });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();

      for (const stop of ['M1', 'M2']) {
        await sim.getByRole('combobox', { name: /stop/i }).selectOption(stop);
        await sim.getByRole('button', { name: /add stop/i }).click();
      }
      await sim.getByRole('button', { name: /Spawn train/i }).click();
      await expect(visualiser.locator('[data-train-id="T1"]')).toBeVisible({ timeout: 8_000 });

      // Close the tab the way a real operator would. Playwright's page.close()
      // triggers the browser's normal unload sequence (including pagehide),
      // which causes useSimRunner to call runner.stop() and publish
      // device_disconnected for each train before the WebSocket closes.
      await sim.close();
      await expect(visualiser.locator('[data-train-id="T1"]')).toHaveCount(0, { timeout: 5_000 });
    });
  });
