import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  assignSchedule,
  clickLearnTrack,
  openSimulatorUi,
  openVisualiser,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

const VIDEO_DIR = resolve(import.meta.dirname, '..', 'screenshots', 'railyard-demo');
mkdirSync(VIDEO_DIR, { recursive: true });

/**
 * The railyard carriage-swap, demonstrated on a railway BUILT BY HAND through
 * the toy-table UI — no preset injection. A real operator's gestures: drag
 * straight track from the toybox, scan each piece onto the bus, teach the line
 * by driving a train down it, then drop a railyard depot and two spare purple
 * wagons. The yard rearranges the train it finds in its throat: the train's
 * leading red pair is swapped for the yard's purple spares — visible on the
 * table as a purple wagon coupling onto the train where a red one used to be.
 *
 * The swap MECHANISM, the ADR-027 handoff, and a wagon migrating between
 * MULTIPLE trains across laps are proven deterministically headless in
 * `packages/integration/railyard-swap-loop.test.ts`. This is the
 * operator-surface proof: the same device, assembled and watched in the real
 * UI, visibly re-liveries a hand-built train.
 */

/** Local EXIT endpoint (index 1) of a straight at rotation 0, in mm — the fresh
 *  open end to click next. From getEndpoints (a straight is 200 mm long). */
const STRAIGHT_EXIT = { x: 100, y: 0 };

/** Read a placed straight's real exit endpoint from its rendered transform, so
 *  the next piece is dropped exactly on it and the toy-table snaps a clean
 *  join — following actual geometry, never an accumulating prediction. */
async function straightExit(
  sim: import('@playwright/test').Page,
  pieceId: string,
): Promise<{ xMm: number; yMm: number }> {
  const transform = await sim.locator(`[data-piece-id="${pieceId}"]`).getAttribute('transform');
  const m =
    /translate\(([-\d.]+),\s*([-\d.]+)\)\s*rotate\(([-\d.]+)\)\s*scale\(1,\s*([-\d.]+)\)/.exec(
      transform ?? '',
    );
  if (m === null) throw new Error(`could not parse transform: ${transform}`);
  const [tx, ty, deg] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const rad = (deg * Math.PI) / 180;
  return {
    xMm: tx + STRAIGHT_EXIT.x * Math.cos(rad),
    yMm: ty + STRAIGHT_EXIT.x * Math.sin(rad),
  };
}

const coupledTo = (sim: import('@playwright/test').Page, carriageId: string) =>
  sim.locator(`[data-piece-id="${carriageId}"]`).getAttribute('data-coupled-to');

test.describe
  .serial('railyard demo: built by hand', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('a hand-placed railyard re-liveries a hand-built train', async ({ browser }) => {
      test.setTimeout(120_000);
      const sim = await openSimulatorUi(browser, {
        brokerUrl: harness.brokerWsUrl,
        recordVideoDir: VIDEO_DIR,
      });
      await sim.setViewportSize({ width: 1280, height: 800 });
      const vis = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
      await vis.setViewportSize({ width: 1280, height: 800 });
      await waitForVisualiserConnected(sim);
      await waitForVisualiserConnected(vis);

      // 1. Lay a straight line of track by hand (kept within the ~900 mm world),
      //    each piece snapping onto the last's real open end.
      // Keep the whole scene in the UPPER band (y≈180) so nothing lands over the
      // scan-box drop zone, which floats over the canvas's bottom-left corner.
      const trackIds: string[] = [];
      let next = { xMm: 280, yMm: 180 };
      for (let i = 0; i < 3; i++) {
        const id = await placePieceOnToyTable(sim, {
          type: 'straight',
          xMm: next.xMm,
          yMm: next.yMm,
        });
        trackIds.push(id);
        next = await straightExit(sim, id);
      }
      await expect(sim.getByText(/track pieces overlap/)).toHaveCount(0);
      for (const id of trackIds) {
        await scanPiece(sim, id);
        await sim.waitForTimeout(60);
      }
      const lastMarker = `M-${trackIds[trackIds.length - 1]}`;

      // 2. Drop a train at the WEST end (it will explore east toward the dead
      //    end) with a rake of RED carriages, and scan the train (the carriages
      //    are wire-invisible — they just sit behind it).
      const trainId = await placePieceOnToyTable(sim, { type: 'train', xMm: 280, yMm: 180 });
      const redIds: string[] = [];
      for (const x of [220, 160]) {
        redIds.push(
          await placePieceOnToyTable(sim, {
            type: 'carriage',
            xMm: x,
            yMm: 180,
            carriageColor: 'red',
          }),
        );
      }
      await scanPiece(sim, trainId);
      await sim.waitForTimeout(200);
      // The red rake is coupled to the train on the table.
      await expect.poll(() => coupledTo(sim, redIds[0] as string)).toBe(trainId);

      // 3. Drop a RAILYARD beside the FAR end marker, with two PURPLE spare
      //    wagons. Keep the spares clear of the train in Y (>100 mm) so they read
      //    as the YARD's spares, not as wagons proximity-coupled to the train.
      //    Scan the yard onto the bus; it now owns the throat at the line's end.
      const yardId = await placePieceOnToyTable(sim, {
        type: 'railyard',
        xMm: next.xMm - 50,
        yMm: 300,
      });
      const purpleIds = [
        await placePieceOnToyTable(sim, {
          type: 'carriage',
          xMm: next.xMm - 80,
          yMm: 330,
          carriageColor: 'purple',
        }),
        await placePieceOnToyTable(sim, {
          type: 'carriage',
          xMm: next.xMm - 20,
          yMm: 330,
          carriageColor: 'purple',
        }),
      ];
      await scanPiece(sim, yardId);
      // Before the swap the purple wagons are the yard's spares, NOT on the train.
      expect(await coupledTo(sim, purpleIds[0] as string)).not.toBe(trainId);

      // 4. Teach the line by driving the train down it (Learn Track), then stop.
      await clickLearnTrack(vis);
      await sim.waitForTimeout(8_000); // a lap or two — long enough to learn the edges
      await clickLearnTrack(vis);

      // 5. The operator assigns the train a schedule that CALLS AT THE YARD: its
      //    route terminates at the throat. The train pulls in, the scheduler
      //    suspends it (ADR-027), and the yard SWAPS its leading red pair for the
      //    purple spares. The exchange, visible on the table:
      //      - both purple wagons couple onto the train, AND
      //      - both red wagons leave it (dropped as the yard's new spares).
      await assignSchedule(vis, {
        trainId: `T-${trainId}`,
        stops: [`M-${trackIds[0]}`, lastMarker],
      });
      await expect
        .poll(() => coupledTo(sim, purpleIds[0] as string), {
          timeout: 60_000,
          message: 'a purple spare should couple onto the train (the swap)',
        })
        .toBe(trainId);
      expect(await coupledTo(sim, purpleIds[1] as string)).toBe(trainId);
      // The red leading pair has been dropped — no longer coupled to the train.
      expect(await coupledTo(sim, redIds[0] as string)).not.toBe(trainId);
      expect(await coupledTo(sim, redIds[1] as string)).not.toBe(trainId);

      // Save the recording of the build + swap as a demo artifact.
      await sim.close();
      const video = sim.video();
      if (video !== null) {
        await video.saveAs(resolve(VIDEO_DIR, 'railyard-demo.webm'));
      }
    });
  });
