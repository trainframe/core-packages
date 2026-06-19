import { expect, test } from '@playwright/test';
import { type CoreEvent, PROTOCOL_VERSION, topics } from '@trainframe/protocol';
import { MqttBrokerClient, type TrackPiece, getEndpoints } from '@trainframe/simulator';
import {
  openSimulatorUi,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * A CLOSED curved LOOP can be built by hand in a spec, and a train laps it.
 *
 * No existing spec places curves — earlier curved loops were built by live
 * chrome-devtools clicks, never deterministically. This proves the second
 * primitive the full connected layout needs (the first being a discoverable
 * junction): eight 45° curves clicked end-to-end close a circle, and an
 * exploring train laps it (crosses a marker TWICE — only possible on a closed
 * ring). Curve chaining reuses the toy-table's own snap+orient: clicking the
 * next curve on the previous curve's open exit snaps its entry there and rotates
 * to continue; all clicked curves share chirality, so eight close 360°.
 */

/** Reconstruct a placed piece from its rendered transform, so the REAL
 *  `getEndpoints` gives its world endpoints (curves aren't collinear, so the
 *  simple half-length trick won't do). */
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
  const flipped = m[4] === '-1';
  return {
    id,
    type,
    position: { x: Number(m[1]), y: Number(m[2]) },
    rotationDeg: Number(m[3]) as TrackPiece['rotationDeg'],
    tagged: false,
    ...(flipped ? { flipped: true } : {}),
  };
}

/** The open exit endpoint (the one NOT near `joinedAt`) of a freshly-placed piece. */
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
    payload: { reason: 'toybox-curved-loop-probe' },
  } as unknown as CoreEvent;
  return new TextEncoder().encode(JSON.stringify(env));
}

test.describe
  .serial('toybox: a hand-built curved loop laps', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9112 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('eight curves close a circle and a train laps it', async ({ browser }) => {
      test.setTimeout(180_000);
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      await sim.setViewportSize({ width: 1280, height: 1120 });
      await waitForVisualiserConnected(sim);
      await zoomOut(sim, 14);

      // Chain eight 45° curves: place the first freely, then click each next one
      // on the previous curve's open exit so the snap continues the arc.
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

      // The ring CLOSES when the 8th curve's exit lands back on the 1st curve's
      // entry. Confirm the eight pieces compiled into a single connected loop by
      // running a train: an exploring loco that crosses the SAME marker twice has
      // lapped a closed ring (a broken chain stops at the gap).
      for (const id of curves) {
        await scanPiece(sim, id);
        await sim.waitForTimeout(60);
      }
      const first = await readPiece(sim, curves[0] ?? '', 'curve');
      const trainPiece = await placePieceOnToyTable(sim, {
        type: 'train',
        xMm: first.position.x,
        yMm: first.position.y,
      });
      await scanPiece(sim, trainPiece);
      const train = `T-${trainPiece}`;

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

      bus.publish(topics.command(train), explorationCommand(train));
      await expect
        .poll(() => Math.max(0, ...visits.values()), {
          timeout: 90_000,
          message: 'the train should LAP the closed ring (cross a marker twice)',
        })
        .toBeGreaterThanOrEqual(2);

      bus.disconnect();
    });
  });
