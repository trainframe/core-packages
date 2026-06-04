import { expect, test } from '@playwright/test';
import {
  openSimulatorUi,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

let harness: UiHarness;

test.describe('Simulator UI: connected to a real broker + server', () => {
  test.beforeAll(async () => {
    harness = await startUiHarness({ discovery: true, wsPort: 9001 });
  });

  test.afterAll(async () => {
    await harness.shutdown();
  });

  test('the UI shows a connected broker status', async ({ browser }) => {
    const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });

    // The connection status badge should flip to connected.
    const status = sim.locator('output[data-status]');
    await expect(status).toHaveAttribute('data-status', 'connected', { timeout: 10_000 });
  });

  test('scanning a track piece publishes a tag_assignment that the server records', async ({
    browser,
  }) => {
    const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });

    // Wait for connected before scanning so the publish goes through.
    await waitForVisualiserConnected(sim);

    const pieceId = await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });
    await scanPiece(sim, pieceId);

    const markerId = `M-${pieceId}`;

    // The server's LayoutState should now know about this marker.
    await expect
      .poll(() => harness.server.getLayoutState().getMarker(markerId) !== undefined, {
        timeout: 10_000,
      })
      .toBe(true);
  });

  test('scanning a train piece registers it in the server scheduler', async ({ browser }) => {
    const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
    await waitForVisualiserConnected(sim);

    // Need track first so the train spawns.
    await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });

    const trainPieceId = await placePieceOnToyTable(sim, { type: 'train', xMm: 450, yMm: 300 });
    await scanPiece(sim, trainPieceId);

    const trainDeviceId = `T-${trainPieceId}`;

    // device_registered from the train reaches the server's scheduler.
    await expect
      .poll(() => harness.server.getScheduler().getTrainState(trainDeviceId)?.train_id, {
        timeout: 10_000,
      })
      .toBe(trainDeviceId);
  });
});
