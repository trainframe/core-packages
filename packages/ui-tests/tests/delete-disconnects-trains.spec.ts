import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import {
  openSimulatorUi,
  openVisualiser,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * The inert-in-place power model, observed from the visualiser:
 *
 *  - POWER OFF keeps the train on the table and on the bus — it goes silent
 *    but emits NO `device_disconnected`, so the visualiser keeps drawing it
 *    (and the server keeps its block reserved).
 *  - DELETE is a genuine despawn — it publishes `device_disconnected` and the
 *    visualiser stops drawing the train.
 *
 * The train icon precondition is satisfied via the Node-side harness
 * simulation (same marker IDs as the server layout) rather than the
 * browser-side toy-table simulation.  The in-browser sim's layout uses
 * `M-straight-N` markers that don't match the server's M1–M4 graph, so
 * `nearestStartEdge` defers spawning there. The Node harness sim does
 * share the graph, so `harness.advance()` produces the `marker_traversed`
 * events the visualiser needs to place the icon.
 *
 * Because the in-browser train never spawned, the delete also exercises the
 * deferred-train disconnect path: the wire-visible `device_disconnected`
 * comes from the toy table directly, not from a sim despawn.
 */

const STOP_LOOP: Layout = {
  name: 'delete-disconnects',
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
  .serial('Operator powers off, then deletes a train; the visualiser follows', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: STOP_LOOP, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('power-off keeps the train icon; deleting the piece removes it', async ({ browser }) => {
      const visualiser = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();
      await waitForVisualiserConnected(sim);

      // Place a straight track piece so the train has somewhere to spawn.
      // Scanning registers the marker with the server.
      const straightId = await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });
      await scanPiece(sim, straightId);

      // Place and scan a train piece. Scanning makes it live on the bus
      // (device_registered is published). The in-browser sim defers spawning
      // because one isolated straight produces no edges — the train won't
      // move in the browser sim and won't emit marker_traversed.
      const trainPieceId = await placePieceOnToyTable(sim, { type: 'train', xMm: 450, yMm: 300 });
      await scanPiece(sim, trainPieceId);

      const trainDeviceId = `T-${trainPieceId}`;

      // Spawn the same train ID in the Node-side harness simulation so it
      // moves on the server's M1–M4 graph. The harness bridge publishes
      // marker_traversed + train_status events the visualiser can position.
      // The duplicate device_registered is handled idempotently by the server.
      harness.simulation.spawnTrain(trainDeviceId, {
        startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      });

      // Advance the harness sim until the train icon appears on the visualiser.
      await expect
        .poll(
          async () => {
            harness.advance(200);
            return await visualiser.locator(`[data-train-id="${trainDeviceId}"]`).count();
          },
          { timeout: 15_000, message: `expected ${trainDeviceId} icon to appear in visualiser` },
        )
        .toBeGreaterThan(0);

      // Disarm the toybox so the next click on the train piece reaches its own
      // handler rather than placing a fresh train. After placePieceOnToyTable
      // the 'train' button is still armed (aria-pressed="true"); clicking it
      // again toggles armedType back to null.
      await sim.getByTestId('toybox-train').click();
      await sim.waitForFunction(() => {
        const btn = document.querySelector('[data-testid="toybox-train"]');
        return btn?.getAttribute('aria-pressed') === 'false';
      });

      // Click the train piece body — this SELECTS it (it does not power off
      // or disconnect). The ActionBar now offers the explicit power affordance.
      const trainPiece = sim.getByTestId(`piece-${trainPieceId}`);
      await trainPiece.click();

      // Power the train off in place. It goes silent on the bus but emits no
      // device_disconnected — the visualiser must keep drawing it.
      await sim.getByTestId('action-power-off').click();
      await sim.waitForTimeout(500);
      await expect(visualiser.locator(`[data-train-id="${trainDeviceId}"]`)).toHaveCount(1);

      // Delete the (still selected) train piece. Delete is a genuine despawn:
      // device_disconnected goes out and the visualiser stops drawing it.
      await sim.keyboard.press('Delete');
      await expect(visualiser.locator(`[data-train-id="${trainDeviceId}"]`)).toHaveCount(0, {
        timeout: 5_000,
      });
    });
  });
