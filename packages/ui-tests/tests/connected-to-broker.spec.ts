import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

const SIMPLE_LOOP: Layout = {
  name: 'simple-loop',
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

let harness: UiHarness;

test.describe('Simulator UI: connected to a real broker + server', () => {
  test.beforeAll(async () => {
    harness = await startUiHarness({ layout: SIMPLE_LOOP, wsPort: 9001 });
  });

  test.afterAll(async () => {
    await harness.shutdown();
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('trainframe.simulator-ui.brokerUrl', 'ws://127.0.0.1:9001');
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Trainframe Simulator/i })).toBeVisible();
  });

  test('the UI shows a connected broker status', async ({ page }) => {
    const status = page.locator('output[data-status]');
    await expect(status).toHaveAttribute('data-status', 'connected', { timeout: 10_000 });
  });

  test('events published by the UI surface in the server`s retained device state', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: /Spawn train/i }).click();

    // The server subscribes to railway/events/+/+ and, on a device_registered
    // event, tracks T1 in its scheduler. Poll until the device_registered
    // event made the full broker round trip.
    await expect
      .poll(() => harness.server.getScheduler().getTrainState('T1')?.train_id, {
        timeout: 10_000,
      })
      .toBe('T1');
  });
});
