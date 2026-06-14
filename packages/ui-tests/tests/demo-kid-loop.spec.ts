import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { VISUALISER_URL } from '../playwright.config.js';
import {
  clickLearnTrack,
  openSimulatorUi,
  openVisualiser,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * The full kid-loop demo. Drives the toy table + visualiser through every
 * feature in the order a kid would touch them — empty table, place pieces,
 * scan them, see the layout grow, scan a train, assign a schedule, watch
 * the train roll, drop carriages, see them trail. Captures screenshots at
 * each step into `screenshots/demo-loop/` as a single demo asset.
 *
 * Not an assertion suite: this is documentation by example. The other e2e
 * specs already pin every behaviour exercised here.
 */

const SCREENSHOT_DIR = resolve(import.meta.dirname, '..', 'screenshots', 'demo-loop');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const settle = (page: import('@playwright/test').Page) => page.waitForTimeout(500);

test.describe
  .serial('demo: kid loop', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      // Discovery mode — the server boots with an empty layout and learns
      // it from the toy-table's scan events, like the kid would experience.
      harness = await startUiHarness({ discovery: true, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('the full kid loop, captured as screenshots', async ({ browser }) => {
      test.setTimeout(120_000);

      /* Wider viewports so the layout-grew screenshots aren't all cramped. The
       * sim window is also TALL (≈3:2) so the toy-table canvas adopts the legacy
       * ~900×600 mm world: the canvas world HEIGHT follows its box aspect (see
       * ToyTable's `clientToMm`), so a short 1280×800 window gives a ~360 mm-tall
       * world that pushes the y=300 carriages down into the bottom-left scan-box
       * drop zone, where the click never reaches the canvas. */
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      await sim.setViewportSize({ width: 1280, height: 1120 });
      const vis = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
      await vis.setViewportSize({ width: 1280, height: 800 });

      await waitForVisualiserConnected(sim);
      await waitForVisualiserConnected(vis);

      // 01. Empty toy table.
      await settle(sim);
      await sim.screenshot({ path: resolve(SCREENSHOT_DIR, '01-empty-toy-table.png') });

      // 02. After placing four straights in a row.
      const straightIds: string[] = [];
      for (const xMm of [150, 350, 550, 750]) {
        straightIds.push(await placePieceOnToyTable(sim, { type: 'straight', xMm, yMm: 300 }));
      }
      await settle(sim);
      await sim.screenshot({ path: resolve(SCREENSHOT_DIR, '02-track-placed.png') });

      // 03. After scanning each straight — the visualiser's layout grows.
      for (const id of straightIds) {
        await scanPiece(sim, id);
        await sim.waitForTimeout(120);
      }
      await settle(vis);
      await vis.screenshot({ path: resolve(SCREENSHOT_DIR, '03-layout-grew-on-visualiser.png') });

      // 04. Place a train near M-straight-1 and scan it.
      const trainPieceId = await placePieceOnToyTable(sim, {
        type: 'train',
        xMm: 150,
        yMm: 300,
      });
      await scanPiece(sim, trainPieceId);
      await settle(sim);
      await sim.screenshot({ path: resolve(SCREENSHOT_DIR, '04-train-scanned.png') });

      // 05. Visualiser shows the new train in the Devices panel + the
      // ScheduleAssigner panel becomes visible.
      await settle(vis);
      await vis.screenshot({
        path: resolve(SCREENSHOT_DIR, '05-train-registered-on-visualiser.png'),
      });

      // 06. Click Learn Track on the visualiser — server starts driving
      // the train edge-by-edge to discover the topology.
      await clickLearnTrack(vis);
      // Pump the in-process simulation forward while the server drives.
      const pump = setInterval(() => harness.advance(50), 20);
      try {
        // Give the train time to traverse the discovered edges.
        await vis.waitForTimeout(3000);
        await vis.screenshot({ path: resolve(SCREENSHOT_DIR, '06-learning-track.png') });

        // Wait a little longer for the loop to close.
        await vis.waitForTimeout(2000);
        await vis.screenshot({
          path: resolve(SCREENSHOT_DIR, '07-track-learn-progress.png'),
        });
      } finally {
        clearInterval(pump);
      }

      // 08. Drop two carriages near the train.
      const carriageOneId = await placePieceOnToyTable(sim, {
        type: 'carriage',
        xMm: 90,
        yMm: 300,
      });
      const carriageTwoId = await placePieceOnToyTable(sim, {
        type: 'carriage',
        xMm: 30,
        yMm: 300,
      });
      await scanPiece(sim, carriageOneId);
      await scanPiece(sim, carriageTwoId);
      await settle(sim);
      await sim.screenshot({ path: resolve(SCREENSHOT_DIR, '08-carriages-coupled.png') });

      // 09. Visualiser final state — all devices registered, layout learned.
      await vis.goto(VISUALISER_URL);
      await waitForVisualiserConnected(vis);
      await settle(vis);
      await vis.screenshot({
        path: resolve(SCREENSHOT_DIR, '09-visualiser-final-state.png'),
        fullPage: true,
      });

      await sim.close();
      await vis.close();
    });
  });
