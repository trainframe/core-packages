import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { type CoreEvent, PROTOCOL_VERSION, topics } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/simulator';
import {
  openSimulatorUi,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * A COMPLETE working railway, BUILT BY HAND through the toy-table toybox and run
 * live over the real `@trainframe/server` scheduler: a junction-free line with a
 * STATION and a drive-through RAILYARD spliced in, TWO trains, each handed a
 * SCHEDULE that calls at the station. The trains bootstrap a heading via
 * `begin_exploration` (a physics loco has no known edge until it rolls across a
 * second marker), then the scheduler routes them — both call at the station and
 * the lead train transits the railyard.
 *
 * (A junction-free line is deliberate: scheduled circulation stalls at junctions
 * whose switch→clearance handshake doesn't complete live; a plain line has none,
 * so the trains run. The full red→purple yard SWAP is proven headless
 * (`integration/railyard-swap-*`, the ToyHardware ACID test) — it needs a
 * discoverable slot-fan the toybox can't hand-place yet.)
 */

/** A placed piece's rendered world transform (mm + rotation). */
async function pieceTransform(sim: import('@playwright/test').Page, id: string) {
  const t = await sim.locator(`[data-piece-id="${id}"]`).getAttribute('transform');
  const m = /translate\(([-\d.]+),\s*([-\d.]+)\)\s*rotate\(([-\d.]+)\)/.exec(t ?? '');
  if (m === null) throw new Error(`no transform for ${id}: ${t}`);
  return { x: Number(m[1]), y: Number(m[2]), deg: Number(m[3]) };
}

/** The open EXIT point (mm) of a placed through-piece, given its half-length. */
async function exitOf(sim: import('@playwright/test').Page, id: string, halfMm: number) {
  const p = await pieceTransform(sim, id);
  const rad = (p.deg * Math.PI) / 180;
  return { xMm: p.x + halfMm * Math.cos(rad), yMm: p.y + halfMm * Math.sin(rad) };
}

/** Scroll-zoom the canvas OUT, centred, so the long (1200mm) railyard + a multi-piece
 *  line are visible + placeable (the helper maps mm→px off the live viewport). */
async function zoomOut(sim: import('@playwright/test').Page, steps: number) {
  const box = await sim.getByTestId('toy-table-canvas').boundingBox();
  if (box === null) throw new Error('canvas not visible');
  await sim.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await sim.mouse.wheel(0, 200);
    await sim.waitForTimeout(20);
  }
  await sim.waitForTimeout(200);
}

function explorationCommand(deviceId: string): Uint8Array {
  const env = {
    command_id: `boot-${deviceId}`,
    device_id: deviceId,
    timestamp_server: new Date(0).toISOString(),
    command_type: 'begin_exploration',
    protocol_version: PROTOCOL_VERSION,
    payload: { reason: 'toybox-railway' },
  } as unknown as CoreEvent;
  return new TextEncoder().encode(JSON.stringify(env));
}

test.describe
  .serial('toybox: a complete working railway built by hand', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9001 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('two scheduled trains call at a station on a hand-built line through a railyard', async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      await sim.setViewportSize({ width: 1280, height: 1120 });
      await waitForVisualiserConnected(sim);

      // Zoom out so the whole line (incl. the 1200mm railyard) fits + is placeable.
      await zoomOut(sim, 13);

      // ── Build the line by hand, west→east, each piece snapping onto the last's
      //    open exit: two west straights (room for two trains), a STATION, a
      //    straight, then a RAILYARD (the drive-through east end). ───────────────
      const y = 240;
      const s0 = await placePieceOnToyTable(sim, { type: 'straight', xMm: 140, yMm: y });
      let e = await exitOf(sim, s0, 100);
      const s1 = await placePieceOnToyTable(sim, { type: 'straight', xMm: e.xMm, yMm: e.yMm });
      e = await exitOf(sim, s1, 100);
      const station = await placePieceOnToyTable(sim, { type: 'station', xMm: e.xMm, yMm: e.yMm });
      e = await exitOf(sim, station, 110);
      const s2 = await placePieceOnToyTable(sim, { type: 'straight', xMm: e.xMm, yMm: e.yMm });
      e = await exitOf(sim, s2, 100);
      // The RAILYARD is the drive-through east end (its far throat M-{yard} is where
      // a transiting train is sensed); no tail piece — it would land off the view.
      const yard = await placePieceOnToyTable(sim, { type: 'railyard', xMm: e.xMm, yMm: e.yMm });

      await expect(sim.getByText(/track pieces overlap/)).toHaveCount(0);
      const trackIds = [s0, s1, station, s2, yard];
      for (const id of trackIds) {
        await scanPiece(sim, id);
        await sim.waitForTimeout(60);
      }
      const mStation = `M-${station}`;
      const mYard = `M-${yard}`;

      // ── Two trains at the WEST end, on s0 and s1. ─────────────────────────────
      const t0 = await pieceTransform(sim, s0);
      const t1 = await pieceTransform(sim, s1);
      const train1Piece = await placePieceOnToyTable(sim, { type: 'train', xMm: t1.x, yMm: t1.y });
      const train2Piece = await placePieceOnToyTable(sim, { type: 'train', xMm: t0.x, yMm: t0.y });
      await scanPiece(sim, train1Piece);
      await scanPiece(sim, train2Piece);
      const train1 = `T-${train1Piece}`;
      const train2 = `T-${train2Piece}`;

      // ── Watch marker crossings; bootstrap each train's heading then schedule it. ─
      const crossings = new Map<string, Set<string>>();
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
          const tid = p?.train_id;
          const mk = p?.marker_id;
          if (typeof tid === 'string' && typeof mk === 'string') {
            if (!crossings.has(tid)) crossings.set(tid, new Set());
            crossings.get(tid)?.add(mk);
          }
        } catch {
          /* ignore */
        }
      });

      // Bootstrap SEQUENTIALLY: explore a train, wait until it has crossed 2 markers
      // (heading known to the server), schedule it to call at the station + run the
      // line, then the next. The lead train clears east before the follower starts.
      const bootstrapAndSchedule = async (trainId: string, stops: string[]) => {
        bus.publish(topics.command(trainId), explorationCommand(trainId));
        await expect
          .poll(() => crossings.get(trainId)?.size ?? 0, { timeout: 40_000 })
          .toBeGreaterThanOrEqual(2);
        harness.server.assignSchedule(trainId, `${trainId}-run`, stops);
        await sim.waitForTimeout(2000);
      };
      await bootstrapAndSchedule(train1, [mStation, mYard]);
      await bootstrapAndSchedule(train2, [mStation]);

      // ── Both trains call at the STATION; the lead train transits the RAILYARD. ──
      await expect
        .poll(() => (crossings.get(train1)?.has(mStation) ? 1 : 0), {
          timeout: 60_000,
          message: 'train 1 should call at the station',
        })
        .toBe(1);
      await expect
        .poll(() => (crossings.get(train2)?.has(mStation) ? 1 : 0), {
          timeout: 60_000,
          message: 'train 2 should also call at the station',
        })
        .toBe(1);
      expect(crossings.get(train1)?.has(mYard), 'the lead train transits the railyard').toBe(true);

      // A demo artifact of the working railway running in the toy-table.
      const shotDir = resolve(import.meta.dirname, '..', 'screenshots');
      mkdirSync(shotDir, { recursive: true });
      await sim.screenshot({ path: resolve(shotDir, 'toybox-working-railway.png') });
      bus.disconnect();
    });
  });
