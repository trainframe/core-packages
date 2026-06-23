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
 * The REAL two-UI loop (goal criteria 1, 4, 6): scan a loco on the toy table and
 * it must surface in the visualiser's commission panel — bridged by a REAL
 * `@trainframe/server` (the only thing that turns the toybox's `device_registered`
 * EVENT into the retained `railway/state/devices/*` the visualiser reads).
 *
 * The harness boots a real server, so this exercises the FIXED topology. The
 * server-less reproduction of the silent void lives in the no-server companion.
 */

test.describe
  .serial('toybox loco scan → visualiser commission (real server)', () => {
    let harness: UiHarness;
    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9116 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('scanning a loco in the toybox surfaces it in the visualiser commission panel', async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      await waitForVisualiserConnected(sim);
      const vis = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
      await waitForVisualiserConnected(vis);

      // Build a tiny bit of track + a loco on it, then SCAN the loco (the real
      // scan-box flow: this publishes device_registered onto the bus).
      await placePieceOnToyTable(sim, { type: 'straight', xMm: 200, yMm: 200 });
      const trainPiece = await placePieceOnToyTable(sim, { type: 'train', xMm: 200, yMm: 200 });
      await scanPiece(sim, trainPiece);
      const deviceId = `T-${trainPiece}`;

      // It must surface in the visualiser commission panel (the real server bridged
      // the event into retained device state the visualiser reads).
      await expect(vis.getByTestId(`commission-item-${deviceId}`)).toBeVisible({ timeout: 30_000 });
    });
  });
