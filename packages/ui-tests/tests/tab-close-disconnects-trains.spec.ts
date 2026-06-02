import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * When the operator closes the simulator-ui tab (or the page navigates away),
 * the `pagehide` event fires and the `useSimRunner` hook calls `runner.stop()`.
 * That despawns each train through the Simulation (emitting `device_disconnected`),
 * so the visualiser stops drawing orphaned train icons.
 *
 * Without the pagehide handler, closing the tab leaves trains visible in the
 * visualiser forever because no disconnect events are published.
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

      await sim.getByRole('button', { name: /Spawn train/i }).click();
      await expect(visualiser.locator('[data-train-id="T1"]')).toBeVisible({ timeout: 8_000 });

      // Simulate the user closing the tab by dispatching `pagehide` while the
      // WebSocket is still open, then closing the context. Direct
      // `context.close()` tears down the WebSocket before the MQTT frame can
      // flush; dispatching the event manually keeps the connection alive for
      // the synchronous publish path.
      await sim.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })),
      );
      await expect(visualiser.locator('[data-train-id="T1"]')).toHaveCount(0, { timeout: 5_000 });
    });
  });
