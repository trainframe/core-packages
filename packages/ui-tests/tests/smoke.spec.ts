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
 * Smoke tests for the toy-table architecture. Each test is framed as
 * "what does the operator do and see?" rather than "what internal state
 * transitions?".
 *
 * The sim-UI is now a toy table: place pieces, scan them into the bus,
 * observe them go live. No spawn form, no lifecycle controls, no layout
 * publishing — just virtual hardware on a canvas.
 */

let harness: UiHarness;

test.describe('Toy table: basic operator flow', () => {
  test.beforeAll(async () => {
    harness = await startUiHarness({ discovery: true, wsPort: 9001 });
  });

  test.afterAll(async () => {
    await harness.shutdown();
  });

  test('the operator lands on a toy table with a toybox and a canvas', async ({ browser }) => {
    const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });

    await expect(sim.getByRole('heading', { name: /Trainframe Toy Table/i })).toBeVisible();
    await expect(sim.getByTestId('toy-table-canvas')).toBeVisible();
    await expect(sim.getByTestId('toybox-straight')).toBeVisible();
    await expect(sim.getByTestId('toybox-train')).toBeVisible();
    await expect(sim.getByTestId('scan-box')).toBeVisible();
  });

  test('placing a straight piece and scanning it makes it live and appears in the visualiser', async ({
    browser,
  }) => {
    const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
    const vis = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });

    await waitForVisualiserConnected(vis);

    // Place a straight piece at the canvas centre.
    const pieceId = await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });

    // Before scanning, the piece is inert (data-live="false").
    const piece = sim.getByTestId(`piece-${pieceId}`);
    await expect(piece).toHaveAttribute('data-live', 'false');

    // Scan it — this emits tag_assignment from GARAGE to the server.
    await scanPiece(sim, pieceId);

    // After scanning, the piece flips to live.
    await expect(piece).toHaveAttribute('data-live', 'true');

    // The server republishes retained layout state, which the visualiser
    // renders as a marker node in its SVG.
    const markerId = `M-${pieceId}`;
    await expect(vis.locator(`[data-marker-id="${markerId}"]`)).toBeVisible({ timeout: 10_000 });
  });

  test('scanning a train piece flips it live', async ({ browser }) => {
    const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });

    // Place a straight first (trains need track to spawn onto).
    await placePieceOnToyTable(sim, { type: 'straight', xMm: 300, yMm: 300 });

    // Place a train at a different position to avoid clicking the straight.
    const trainId = await placePieceOnToyTable(sim, { type: 'train', xMm: 600, yMm: 300 });

    const trainEl = sim.getByTestId(`piece-${trainId}`);
    await expect(trainEl).toHaveAttribute('data-live', 'false');

    await scanPiece(sim, trainId);

    await expect(trainEl).toHaveAttribute('data-live', 'true');
  });
});
