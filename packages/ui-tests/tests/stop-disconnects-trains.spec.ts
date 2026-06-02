import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * When the operator clicks Stop in the simulator-ui, the running trains
 * are torn down locally — but if the SimRunner doesn't tell the broker,
 * the visualiser keeps drawing the icons forever. The fix is to despawn
 * each train through the Simulation (which emits `device_disconnected`)
 * before the sim is destroyed, and have the visualiser's train hooks
 * remove the entry when they see the disconnect.
 */

const STOP_LOOP: Layout = {
  name: 'stop-disconnects',
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
  .serial('Operator stops the sim and the visualiser stops drawing the train', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: STOP_LOOP, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('clicking Stop removes the train icon from the visualiser', async ({ browser }) => {
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, { layout: STOP_LOOP });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();

      for (const stop of ['M1', 'M2']) {
        await sim.getByRole('combobox', { name: /stop/i }).selectOption(stop);
        await sim.getByRole('button', { name: /add stop/i }).click();
      }
      await sim.getByRole('button', { name: /Spawn train/i }).click();
      await expect(visualiser.locator('[data-train-id="T1"]')).toBeVisible({ timeout: 8_000 });

      await sim.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(visualiser.locator('[data-train-id="T1"]')).toHaveCount(0, { timeout: 5_000 });
    });
  });
