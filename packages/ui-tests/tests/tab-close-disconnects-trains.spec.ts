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
 * When the operator closes the simulator-ui tab, the browser fires `pagehide`
 * before tearing down the page. The toy-table's `pagehide` listener publishes
 * `device_disconnected` for each live wire-device piece before the WebSocket
 * closes. The visualiser's train hooks remove a train when they see that event,
 * so the icon disappears.
 *
 * Without the pagehide handler, closing the tab leaves trains visible in the
 * visualiser forever because no disconnect events are published.
 *
 * The train icon precondition is satisfied via the Node-side harness
 * simulation (same marker IDs as the server layout) rather than the
 * browser-side toy-table simulation.  The in-browser sim's layout uses
 * `M-straight-N` markers that don't match the server's M1–M4 graph, so
 * `nearestStartEdge` defers spawning there. The Node harness sim shares
 * the graph and produces the `marker_traversed` events the visualiser
 * needs to place the icon.
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
      const visualiser = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();
      await waitForVisualiserConnected(sim);

      // Place and scan a straight piece so the toy-table sim knows about a marker.
      const straightId = await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });
      await scanPiece(sim, straightId);

      // Place and scan a train piece to bring it live on the bus. The in-browser
      // sim defers spawning (one isolated straight → no edges), but the
      // device_registered is published, and liveIds now includes this piece.
      const trainPieceId = await placePieceOnToyTable(sim, { type: 'train', xMm: 450, yMm: 300 });
      await scanPiece(sim, trainPieceId);

      const trainDeviceId = `T-${trainPieceId}`;

      // Spawn the same train ID in the Node-side harness simulation so it moves
      // on the server's M1–M4 graph and emits marker_traversed events the
      // visualiser can use to position the icon.
      harness.spawnTrain(trainDeviceId, {
        startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      });

      // Advance the harness sim until the train icon appears in the visualiser.
      await expect
        .poll(
          async () => {
            harness.advance(200);
            return await visualiser.locator(`[data-train-id="${trainDeviceId}"]`).count();
          },
          { timeout: 15_000, message: `expected ${trainDeviceId} icon to appear in visualiser` },
        )
        .toBeGreaterThan(0);

      // Close the tab the way a real operator would. Playwright's page.close()
      // triggers the browser's normal unload sequence (including pagehide),
      // which causes ToyTable's pagehide listener to publish device_disconnected
      // for each live wire-device piece before the WebSocket closes.
      await sim.close();
      await expect(visualiser.locator(`[data-train-id="${trainDeviceId}"]`)).toHaveCount(0, {
        timeout: 5_000,
      });
    });
  });
