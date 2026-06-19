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
 * A hand-built JUNCTION is discoverable + traversable live.
 *
 * Earlier the complete-railway spec deliberately avoided junctions, noting their
 * switch→clearance handshake "doesn't complete live". The real cause was narrower:
 * a freshly-compiled `PhysicsWorld` starts with an EMPTY switch map, so until a
 * junction's points are set the compiled net gates the junction's facing move
 * CLOSED — an exploring train stalls just inside the junction and the track beyond
 * it is never discovered. ToyHardware now rests every junction on its through leg
 * ('main') and re-asserts it onto each rebuilt world, so a plain junction behaves
 * as straight-through until something throws it.
 *
 * This builds a straight line with an INLINE junction (branch left as a stub — so
 * there is no curve-closure variable), then lets one train explore. It must cross
 * the junction marker AND reach the station east of it: proof the junction's
 * through path is open and the far side is discoverable.
 */

async function pieceTransform(sim: import('@playwright/test').Page, id: string) {
  const t = await sim.locator(`[data-piece-id="${id}"]`).getAttribute('transform');
  const m = /translate\(([-\d.]+),\s*([-\d.]+)\)\s*rotate\(([-\d.]+)\)/.exec(t ?? '');
  if (m === null) throw new Error(`no transform for ${id}: ${t}`);
  return { x: Number(m[1]), y: Number(m[2]), deg: Number(m[3]) };
}

/** The open EXIT (mm) of a placed piece whose exit endpoint sits `halfMm` along
 *  its rotation from centre (collinear pieces: straight/station/junction-through). */
async function exitOf(sim: import('@playwright/test').Page, id: string, halfMm: number) {
  const p = await pieceTransform(sim, id);
  const rad = (p.deg * Math.PI) / 180;
  return { xMm: p.x + halfMm * Math.cos(rad), yMm: p.y + halfMm * Math.sin(rad) };
}

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
    payload: { reason: 'toybox-junction-probe' },
  } as unknown as CoreEvent;
  return new TextEncoder().encode(JSON.stringify(env));
}

test.describe
  .serial('toybox: a hand-built junction is discoverable + traversable', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9111 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('an exploring train crosses an inline junction and discovers the track beyond', async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      await sim.setViewportSize({ width: 1280, height: 1120 });
      await waitForVisualiserConnected(sim);
      await zoomOut(sim, 13);

      // ── Build a line west→east, each piece snapping onto the last's exit:
      //    two west straights (room for the train to bootstrap), an inline
      //    JUNCTION (branch left as a stub), a straight, a STATION, a straight. ──
      const y = 240;
      const s0 = await placePieceOnToyTable(sim, { type: 'straight', xMm: 140, yMm: y });
      let e = await exitOf(sim, s0, 100);
      const s1 = await placePieceOnToyTable(sim, { type: 'straight', xMm: e.xMm, yMm: e.yMm });
      e = await exitOf(sim, s1, 100);
      const junction = await placePieceOnToyTable(sim, {
        type: 'junction',
        xMm: e.xMm,
        yMm: e.yMm,
      });
      e = await exitOf(sim, junction, 100); // the through (east) leg; branch is a stub
      const s2 = await placePieceOnToyTable(sim, { type: 'straight', xMm: e.xMm, yMm: e.yMm });
      e = await exitOf(sim, s2, 100);
      const station = await placePieceOnToyTable(sim, { type: 'station', xMm: e.xMm, yMm: e.yMm });
      e = await exitOf(sim, station, 110);
      const s3 = await placePieceOnToyTable(sim, { type: 'straight', xMm: e.xMm, yMm: e.yMm });

      await expect(sim.getByText(/track pieces overlap/)).toHaveCount(0);
      for (const id of [s0, s1, junction, s2, station, s3]) {
        await scanPiece(sim, id);
        await sim.waitForTimeout(60);
      }
      const mJunction = `M-${junction}`;
      const mStation = `M-${station}`;

      // ── One train at the WEST end (on s0). ──
      const t0 = await pieceTransform(sim, s0);
      const trainPiece = await placePieceOnToyTable(sim, { type: 'train', xMm: t0.x, yMm: t0.y });
      await scanPiece(sim, trainPiece);
      const train = `T-${trainPiece}`;

      // ── Watch marker crossings. ──
      const crossed = new Set<string>();
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
          if (p?.train_id === train && typeof p.marker_id === 'string') crossed.add(p.marker_id);
        } catch {
          /* ignore */
        }
      });

      // Bootstrap the train's heading, then let it EXPLORE. The junction rests on
      // its through leg, so the facing move is OPEN: the train crosses the junction
      // and discovers the station east of it.
      bus.publish(topics.command(train), explorationCommand(train));

      await expect
        .poll(() => (crossed.has(mJunction) ? 1 : 0), {
          timeout: 60_000,
          message: 'the exploring train should traverse THROUGH the junction',
        })
        .toBe(1);
      await expect
        .poll(() => (crossed.has(mStation) ? 1 : 0), {
          timeout: 60_000,
          message: 'the train should discover the station east of the junction',
        })
        .toBe(1);

      bus.disconnect();
    });
  });
