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
 * straight track from the toybox, splice a railyard onto the end of the line,
 * scan each piece onto the bus, teach the line by driving a train down it, then
 * schedule the train to call at the yard. The yard rearranges the train it
 * finds in its throat: the train's leading red pair is swapped for the yard's
 * purple spares — visible on the table as a purple wagon coupling onto the
 * train where a red one used to be.
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

/** Read a placed piece's rendered transform: world centre (mm) and rotation. */
async function pieceTransform(
  sim: import('@playwright/test').Page,
  pieceId: string,
): Promise<{ xMm: number; yMm: number; deg: number }> {
  const transform = await sim.locator(`[data-piece-id="${pieceId}"]`).getAttribute('transform');
  const m =
    /translate\(([-\d.]+),\s*([-\d.]+)\)\s*rotate\(([-\d.]+)\)\s*scale\(1,\s*([-\d.]+)\)/.exec(
      transform ?? '',
    );
  if (m === null) throw new Error(`could not parse transform: ${transform}`);
  return { xMm: Number(m[1]), yMm: Number(m[2]), deg: Number(m[3]) };
}

/** A placed straight's real exit endpoint, so the next piece is dropped exactly
 *  on it and the toy-table snaps a clean join — following actual geometry, never
 *  an accumulating prediction. */
async function straightExit(
  sim: import('@playwright/test').Page,
  pieceId: string,
): Promise<{ xMm: number; yMm: number }> {
  const { xMm, yMm, deg } = await pieceTransform(sim, pieceId);
  const rad = (deg * Math.PI) / 180;
  return {
    xMm: xMm + STRAIGHT_EXIT.x * Math.cos(rad),
    yMm: yMm + STRAIGHT_EXIT.x * Math.sin(rad),
  };
}

const coupledTo = (sim: import('@playwright/test').Page, carriageId: string) =>
  sim.locator(`[data-piece-id="${carriageId}"]`).getAttribute('data-coupled-to');

/** The train's rendered world-x and heading (rotation), for watching it drive. */
async function trainPose(
  sim: import('@playwright/test').Page,
  trainId: string,
): Promise<{ xMm: number; deg: number }> {
  const { xMm, deg } = await pieceTransform(sim, trainId);
  return { xMm, deg };
}

/** Scroll-zoom the toy-table OUT, centred on the canvas, so a long inline piece
 *  (the 1200 mm railyard) and the spares beside it are visible and placeable —
 *  the helper maps mm→px off the live viewport, so placement stays correct. */
async function zoomCanvasOut(sim: import('@playwright/test').Page, steps: number): Promise<void> {
  const box = await sim.getByTestId('toy-table-canvas').boundingBox();
  if (box === null) throw new Error('toy-table canvas not visible');
  await sim.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await sim.mouse.wheel(0, 200);
    await sim.waitForTimeout(20);
  }
  await sim.waitForTimeout(200);
}

/**
 * Drive the train down the line under track-learn until it has discovered the
 * edge into the yard AND returned to settle at the WEST start (two consecutive
 * samples agree it has stopped, well clear of the yard). Returns whether both
 * conditions were met within the budget. From a settled west start the operator
 * can route the train forward INTO the throat (a genuine pull-in).
 */
async function learnLineAndSettleAtStart(
  harness: UiHarness,
  sim: import('@playwright/test').Page,
  trainId: string,
  yardMarker: string,
): Promise<{ learnedYardEdge: boolean; settledWest: boolean }> {
  let learnedYardEdge = false;
  let settledWest = false;
  let prevX = Number.NaN;
  for (let i = 0; i < 100; i++) {
    await sim.waitForTimeout(600);
    const edges = harness.server.getLayoutState().toLayout().edges;
    if (edges.some((e) => e.to_marker_id === yardMarker)) learnedYardEdge = true;
    const { xMm } = await trainPose(sim, trainId);
    if (learnedYardEdge && xMm < 380 && Math.abs(xMm - prevX) < 2) {
      settledWest = true;
      break;
    }
    prevX = xMm;
  }
  return { learnedYardEdge, settledWest };
}

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
      /* A tall window so the toy-table canvas adopts a ~3:2 world (its world
       * HEIGHT follows the box aspect — see ToyTable's `clientToMm`); a short
       * window would clip the build below the canvas. */
      await sim.setViewportSize({ width: 1280, height: 1120 });
      const vis = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
      await vis.setViewportSize({ width: 1280, height: 800 });
      await waitForVisualiserConnected(sim);
      await waitForVisualiserConnected(vis);

      // 1. Lay a straight line of track by hand in the UPPER band (y≈180, clear of
      //    the scan-box drop zone in the bottom-left), each piece snapping onto
      //    the last's real open end.
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

      // 2. Splice a RAILYARD onto the line's open east end — it is itself a length
      //    of track that OWNS a marker (its throat). Inline like this, teaching
      //    the line drives the train through it and learns the edge into the yard,
      //    so the operator can later route a train to the throat.
      const yardId = await placePieceOnToyTable(sim, {
        type: 'railyard',
        xMm: next.xMm,
        yMm: next.yMm,
      });
      await expect(sim.getByText(/track pieces overlap/)).toHaveCount(0);
      for (const id of [...trackIds, yardId]) {
        await scanPiece(sim, id);
        await sim.waitForTimeout(60);
      }
      const yardMarker = `M-${yardId}`;

      // 3. Drop a train at the WEST end (it will explore east toward the yard) with
      //    a rake of RED carriages, and scan the train (the carriages are
      //    wire-invisible — they just sit behind it).
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

      // 4. Park two PURPLE spare wagons beside the yard. The railyard is 1200 mm
      //    long, so its centre sits well east of the ~900 mm default world — zoom
      //    the canvas out first so both the yard and the spares are placeable. The
      //    spares are dropped within coupling distance of the yard's centre and
      //    clear of the train, so they read as the YARD's spares, not as wagons
      //    coupled to the train.
      await zoomCanvasOut(sim, 12);
      const yard = await pieceTransform(sim, yardId);
      const purpleIds = [
        await placePieceOnToyTable(sim, {
          type: 'carriage',
          xMm: yard.xMm - 30,
          yMm: yard.yMm + 60,
          carriageColor: 'purple',
        }),
        await placePieceOnToyTable(sim, {
          type: 'carriage',
          xMm: yard.xMm + 30,
          yMm: yard.yMm + 60,
          carriageColor: 'purple',
        }),
      ];
      await sim.waitForTimeout(200);
      // Before the swap the purple wagons are the yard's spares, NOT on the train.
      expect(await coupledTo(sim, purpleIds[0] as string)).not.toBe(trainId);

      // 5. Teach the line by driving the train down it (Learn Track). The train
      //    self-explores east to the dead-end yard and back. Learn-track completes
      //    when it returns to its start marker having traversed the reachable
      //    graph, releasing it parked at the WEST end. Wait for that: the edge
      //    into the yard learned AND the train settled back near the start (a
      //    stable west position). From there a single forward schedule routes it
      //    INTO the throat (a genuine pull-in), rather than leaving it parked at
      //    the throat unserviced.
      await clickLearnTrack(vis);
      const learn = await learnLineAndSettleAtStart(harness, sim, trainId, yardMarker);
      expect(learn.learnedYardEdge, 'learn-track should discover the edge into the yard').toBe(
        true,
      );
      expect(learn.settledWest, 'the train should return and settle at the west start').toBe(true);
      /* Stop learning so the scheduler owns the train (the button sends
       * `learn_track_stop` for any non-idle state, including an auto-completed
       * lap), then let any in-flight motion settle. */
      await clickLearnTrack(vis);
      await sim.waitForTimeout(1000);

      // 6. The operator assigns the train a schedule that TERMINATES AT THE YARD
      //    throat. The train pulls in, the scheduler suspends it (ADR-027), and
      //    the yard SWAPS its leading red pair for the purple spares. The
      //    exchange, visible on the table:
      //      - both purple wagons couple onto the train, AND
      //      - both red wagons leave it (dropped as the yard's new spares).
      await assignSchedule(vis, {
        trainId: `T-${trainId}`,
        stops: [yardMarker],
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
