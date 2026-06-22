import { expect, test } from '@playwright/test';
import { MqttBrokerClient, type TrackPiece, getEndpoints } from '@trainframe/simulator';
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
 * LEARN-TRACK over the LIVE stack (goal criteria 5 & 6, learn-track half).
 *
 * The regression: a scanned train could no longer take the "Learn track" option.
 * Here the FULL live path runs — the operator hand-builds a closed loop on the
 * toy table (simulator-ui), scans a loco, and presses the visualiser's REAL
 * "Learn track" button (which publishes `railway/operator/learn_track_start`).
 * The server's LearnMode must latch the loco and drive it; we assert it EXPLORES
 * — it crosses ≥3 distinct markers and laps the ring (a marker seen twice). The
 * sim-ui session is recorded for the criterion-6 review.
 *
 * This is the live counterpart to the headless regression in
 * `simulator-ui/src/sim/toy-hardware.test.ts` ("Learn track over the broker"),
 * which additionally pins the OFF-marker cold-start case the fix addresses.
 */

async function readPiece(
  sim: import('@playwright/test').Page,
  id: string,
  type: TrackPiece['type'],
): Promise<TrackPiece> {
  const t = await sim.locator(`[data-piece-id="${id}"]`).getAttribute('transform');
  const m =
    /translate\(([-\d.]+),\s*([-\d.]+)\)\s*rotate\(([-\d.]+)\)(?:\s*scale\(1,\s*(-?1)\))?/.exec(
      t ?? '',
    );
  if (m === null) throw new Error(`no transform for ${id}: ${t}`);
  return {
    id,
    type,
    position: { x: Number(m[1]), y: Number(m[2]) },
    rotationDeg: Number(m[3]) as TrackPiece['rotationDeg'],
    tagged: false,
    ...(m[4] === '-1' ? { flipped: true } : {}),
  };
}

/** The open exit endpoint (the one NOT near `joinedAt`) of a placed piece. */
async function openExitOf(
  sim: import('@playwright/test').Page,
  id: string,
  type: TrackPiece['type'],
  joinedAt: { x: number; y: number } | null,
): Promise<{ x: number; y: number }> {
  const eps = getEndpoints(await readPiece(sim, id, type));
  if (joinedAt === null) {
    const ep = eps[1] ?? eps[0];
    if (ep === undefined) throw new Error(`no endpoints for ${id}`);
    return { x: ep.x, y: ep.y };
  }
  let best = eps[0];
  let bestD = -1;
  for (const ep of eps) {
    const d = Math.hypot(ep.x - joinedAt.x, ep.y - joinedAt.y);
    if (d > bestD) {
      bestD = d;
      best = ep;
    }
  }
  if (best === undefined) throw new Error(`no endpoints for ${id}`);
  return { x: best.x, y: best.y };
}

async function zoomOut(sim: import('@playwright/test').Page, steps: number): Promise<void> {
  const box = await sim.getByTestId('toy-table-canvas').boundingBox();
  if (box === null) throw new Error('canvas not visible');
  await sim.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await sim.mouse.wheel(0, 200);
    await sim.waitForTimeout(20);
  }
  await sim.waitForTimeout(200);
}

const VIDEO_DIR = new URL('../videos/learn-track/', import.meta.url).pathname;

test.describe
  .serial('learn-track: a scanned loco takes the option and explores (live)', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9114 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('the operator builds a loop, scans a loco, presses Learn track — it explores', async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const sim = await openSimulatorUi(browser, {
        brokerUrl: harness.brokerWsUrl,
        recordVideoDir: VIDEO_DIR,
        recordVideoSize: { width: 1280, height: 1120 },
      });
      await sim.setViewportSize({ width: 1280, height: 1120 });
      await waitForVisualiserConnected(sim);
      await zoomOut(sim, 14);

      // Hand-build a closed ring: eight 45° curves clicked end-to-end (each next
      // curve on the previous one's open exit), as in the curved-loop probe.
      const curves: string[] = [];
      let join: { x: number; y: number } | null = null;
      let exit = { x: 360, y: 200 };
      for (let i = 0; i < 8; i++) {
        const id = await placePieceOnToyTable(sim, { type: 'curve', xMm: exit.x, yMm: exit.y });
        curves.push(id);
        const next = await openExitOf(sim, id, 'curve', join);
        join = exit;
        exit = next;
      }
      await expect(sim.getByText(/track pieces overlap/)).toHaveCount(0);
      for (const id of curves) {
        await scanPiece(sim, id);
        await sim.waitForTimeout(60);
      }

      // Place + scan a loco ON the ring (at the first curve's centre).
      const first = await readPiece(sim, curves[0] ?? '', 'curve');
      const trainPiece = await placePieceOnToyTable(sim, {
        type: 'train',
        xMm: first.position.x,
        yMm: first.position.y,
      });
      await scanPiece(sim, trainPiece);
      const train = `T-${trainPiece}`;

      // Listen for the loco's marker crossings on the broker.
      const visits = new Map<string, number>();
      const bus = new MqttBrokerClient();
      bus.connect(harness.brokerWsUrl);
      await sim.waitForTimeout(300);
      bus.subscribe('railway/events/marker_traversed/+', (msg) => {
        try {
          const p = (
            JSON.parse(new TextDecoder().decode(msg.payload)) as {
              payload?: { train_id?: unknown; marker_id?: unknown };
            }
          ).payload;
          if (p?.train_id === train && typeof p.marker_id === 'string')
            visits.set(p.marker_id, (visits.get(p.marker_id) ?? 0) + 1);
        } catch {
          /* ignore */
        }
      });

      // THE OPERATOR PRESSES "Learn track" in the visualiser — the real live path.
      const vis = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
      await waitForVisualiserConnected(vis);
      await sim.waitForTimeout(300);
      await clickLearnTrack(vis);

      // The loco must EXPLORE: from the single Learn-track press it drives itself
      // and crosses several distinct markers (a stalled cold start crosses NONE).
      // LearnMode then halts it on completion, so we assert distinct discovery —
      // not a marker-seen-twice (that is the never-completing direct-exploration
      // probe's signature, not learn-track's).
      await expect
        .poll(() => visits.size, { timeout: 90_000, message: 'loco should discover ≥3 markers' })
        .toBeGreaterThanOrEqual(3);

      // The server learned the loop's edges from the exploration it provoked — the
      // cold-start layout GREW (markers without edges → edges discovered).
      await expect
        .poll(() => harness.server.getLayoutState().toLayout().edges.length, {
          timeout: 90_000,
          message: 'the cold-start layout should grow edges as the loco explores',
        })
        .toBeGreaterThanOrEqual(3);

      await sim.waitForTimeout(800); // a beat of steady running on camera
      bus.disconnect();
      await vis.close();
      await sim.close();
    });
  });
