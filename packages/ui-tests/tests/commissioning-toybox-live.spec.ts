import { expect, test } from '@playwright/test';
import {
  openSimulatorUi,
  openVisualiser,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * The REAL two-UI loop (goal criteria 4, 6, 7), bridged by a REAL
 * `@trainframe/server` — the only thing that turns the toybox's `device_registered`
 * EVENT into the retained `railway/state/devices/*` the visualiser reads (the
 * missing piece behind the silent void; see `pnpm dev:stack`).
 *
 * Scan a loco on the toy table → it surfaces in the visualiser Commission panel →
 * the operator names + measures it → the Devices roster shows the friendly name +
 * length → it survives a visualiser reload. Recorded for the criterion-7 review.
 */

const VIDEO_DIR = new URL('../videos/commissioning-toybox/', import.meta.url).pathname;

test.describe
  .serial('toybox loco scan → visualiser commission (real server)', () => {
    let harness: UiHarness;
    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9116 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('scan a loco on the table → commission it in the visualiser → it persists across a reload', async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      await waitForVisualiserConnected(sim);
      const vis = await openVisualiser(browser, {
        brokerUrl: harness.brokerWsUrl,
        recordVideoDir: VIDEO_DIR,
      });
      await waitForVisualiserConnected(vis);

      // Place a loco on a bit of track and SCAN it (the real scan-box flow, which
      // publishes device_registered onto the bus).
      await placePieceOnToyTable(sim, { type: 'straight', xMm: 200, yMm: 200 });
      const trainPiece = await placePieceOnToyTable(sim, { type: 'train', xMm: 200, yMm: 200 });
      await scanPiece(sim, trainPiece);
      const deviceId = `T-${trainPiece}`;

      // The real server bridged the event → retained state → it QUEUES in the
      // visualiser Commission panel, suggested as a train.
      const item = vis.getByTestId(`commission-item-${deviceId}`);
      await expect(item).toBeVisible({ timeout: 30_000 });
      await expect(vis.getByTestId(`commission-category-${deviceId}`)).toHaveValue('train');

      // The operator names + measures it, then confirms.
      await vis.getByTestId(`commission-name-${deviceId}`).fill('Flying Scotsman');
      await vis.getByTestId(`commission-length-${deviceId}`).fill('180');
      await vis.waitForTimeout(400);
      await vis.getByTestId(`commission-confirm-${deviceId}`).click();

      // The Devices roster now shows the friendly name + length; the queue clears.
      await expect(vis.getByTestId(`device-row-${deviceId}`)).toContainText('Flying Scotsman', {
        timeout: 30_000,
      });
      await expect(vis.getByTestId(`device-length-${deviceId}`)).toHaveText('180 mm');
      await expect(vis.getByTestId(`commission-item-${deviceId}`)).toHaveCount(0);
      await vis.waitForTimeout(900);

      // Survives a visualiser reload (the server's retained snapshot is durable).
      await vis.reload({ waitUntil: 'domcontentloaded' });
      await waitForVisualiserConnected(vis);
      await expect(vis.getByTestId(`device-row-${deviceId}`)).toContainText('Flying Scotsman', {
        timeout: 30_000,
      });
      await expect(vis.getByTestId(`device-length-${deviceId}`)).toHaveText('180 mm');
      await vis.waitForTimeout(3000); // hold the post-reload state on camera

      await vis.context().close();
    });
  });
