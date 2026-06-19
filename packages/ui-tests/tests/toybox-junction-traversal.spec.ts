import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * TWO loops joined by a JUNCTION link, and ONE train that traverses BOTH by
 * routing THROUGH the junctions — built by hand through the toy-table UI, run
 * over the real `@trainframe/server`. Each loop is an oval with an inline junction
 * on its bottom side; the two junctions' spare (branch) legs are joined by a short
 * connector. With the junctions thrown to DIVERT, a circulating train reaches its
 * loop's junction, takes the branch across the connector into the OTHER loop, runs
 * round that, and crosses back — so the single train tours the whole map by using
 * the junctions. No track crosses over itself. Records a video.
 */

type XY = { x: number; y: number };

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

async function endpointsOf(
  sim: import('@playwright/test').Page,
  id: string,
  type: TrackPiece['type'],
): Promise<XY[]> {
  return getEndpoints(await readPiece(sim, id, type)).map((e) => ({ x: e.x, y: e.y }));
}

async function farEndpoint(
  sim: import('@playwright/test').Page,
  id: string,
  type: TrackPiece['type'],
  from: XY,
): Promise<XY> {
  const eps = await endpointsOf(sim, id, type);
  let best = eps[0];
  let bestD = -1;
  for (const ep of eps) {
    const d = Math.hypot(ep.x - from.x, ep.y - from.y);
    if (d > bestD) {
      bestD = d;
      best = ep;
    }
  }
  if (best === undefined) throw new Error(`no endpoints for ${id}`);
  return best;
}

async function zoomOut(sim: import('@playwright/test').Page, steps: number) {
  const box = await sim.getByTestId('toy-table-canvas').boundingBox();
  if (box === null) throw new Error('canvas not visible');
  await sim.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) {
    await sim.mouse.wheel(0, 200);
    await sim.waitForTimeout(15);
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
    payload: { reason: 'junction-traversal' },
  } as unknown as CoreEvent;
  return new TextEncoder().encode(JSON.stringify(env));
}

function setSwitchCommand(junctionPieceId: string, position: string): Uint8Array {
  const env = {
    command_id: `sw-${junctionPieceId}-${position}`,
    device_id: `SWITCH-${junctionPieceId}`,
    timestamp_server: new Date(0).toISOString(),
    command_type: 'set_switch_position',
    protocol_version: PROTOCOL_VERSION,
    payload: { junction_marker_id: `M-${junctionPieceId}`, position },
  } as unknown as CoreEvent;
  return new TextEncoder().encode(JSON.stringify(env));
}

interface BuiltLoop {
  junction: string;
  pieces: string[];
  branch: XY;
  trainAt: XY;
  markers: string[];
}

/** A horizontal oval whose bottom side is an inline junction (branch = the spare
 *  leg used to link to the other loop). Placed by its junction's free position. */
async function buildLoop(sim: import('@playwright/test').Page, centre: XY): Promise<BuiltLoop> {
  const pieces: string[] = [];
  const junction = await placePieceOnToyTable(sim, {
    type: 'junction',
    xMm: centre.x,
    yMm: centre.y,
  });
  pieces.push(junction);
  const jEps = await endpointsOf(sim, junction, 'junction');
  // Chain the oval off the TRUNK leg (not through): a circulating train then meets
  // the junction as a FACING move (trunk → {through, branch}), so throwing the
  // points to 'divert' actually sends it down the branch — the link to the other
  // loop. The branch (jEps[2]) stays the spare connector.
  const trunk = jEps[0];
  const branch = jEps[2];
  if (trunk === undefined || branch === undefined) throw new Error('junction endpoints missing');

  let tip: XY = trunk;
  let prev: XY = { ...centre };
  const chain = async (type: TrackPiece['type']): Promise<string> => {
    const id = await placePieceOnToyTable(sim, { type, xMm: tip.x, yMm: tip.y });
    pieces.push(id);
    const next = await farEndpoint(sim, id, type, prev);
    prev = tip;
    tip = next;
    return id;
  };
  // Rounded-rectangle oval: a STRAIGHT buffer each side of the junction (so no
  // curve sits right against it — its branch plank then has clear space and never
  // grazes a neighbour), four curves up, three straights across the top (matching
  // the buffered bottom so the oval closes), four curves down, a closing buffer.
  await chain('straight');
  for (let i = 0; i < 4; i++) await chain('curve');
  await chain('straight');
  const top = await chain('straight');
  await chain('straight');
  for (let i = 0; i < 4; i++) await chain('curve');
  await chain('straight');

  const topMid = await readPiece(sim, top, 'straight');
  return {
    junction,
    pieces,
    branch: { x: branch.x, y: branch.y },
    trainAt: { x: topMid.position.x, y: topMid.position.y },
    markers: pieces.map((p) => `M-${p}`),
  };
}

test.describe
  .serial('toybox: a train traverses two loops through junctions', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9114 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('one train tours both loops by routing through the junction link', async ({ browser }) => {
      test.setTimeout(240_000);
      const videoDir = resolve(import.meta.dirname, '..', 'videos', 'junction-traversal');
      mkdirSync(videoDir, { recursive: true });
      const shotDir = resolve(import.meta.dirname, '..', 'screenshots');
      mkdirSync(shotDir, { recursive: true });

      const sim = await openSimulatorUi(browser, {
        brokerUrl: harness.brokerWsUrl,
        recordVideoDir: videoDir,
      });
      await sim.setViewportSize({ width: 1280, height: 900 });
      await waitForVisualiserConnected(sim);
      await zoomOut(sim, 28);

      const allPieces: string[] = [];
      const BRANCH_OFF = 100 * Math.cos(Math.PI / 4);

      // Loop A (free), a short connector off its branch, then Loop B positioned so
      // its OWN branch lands on the connector end — the two loops joined branch-to-
      // branch through their junctions.
      const loopA = await buildLoop(sim, { x: 600, y: 700 });
      allPieces.push(...loopA.pieces);

      let prev: XY = { x: loopA.branch.x - 50, y: loopA.branch.y - 50 };
      let tip = loopA.branch;
      // A leading curve bends the link away from loop A's oval before it runs
      // straight, so the connector never grazes the loop at the junction; the
      // straights then carry it clear to where loop B is placed.
      const linkSteps: { type: TrackPiece['type']; flip: boolean }[] = [
        { type: 'curve', flip: false },
        { type: 'straight', flip: false },
        { type: 'straight', flip: false },
        { type: 'curve', flip: false },
      ];
      for (const step of linkSteps) {
        const id = await placePieceOnToyTable(sim, {
          type: step.type,
          xMm: tip.x,
          yMm: tip.y,
          flip: step.flip,
        });
        allPieces.push(id);
        const next = await farEndpoint(sim, id, step.type, prev);
        prev = tip;
        tip = next;
      }
      const loopB = await buildLoop(sim, { x: tip.x - BRANCH_OFF, y: tip.y - BRANCH_OFF });
      allPieces.push(...loopB.pieces);

      await sim.screenshot({ path: resolve(shotDir, 'junction-traversal-built.png') });
      // The whole map is one clean, physically-buildable layout — no track-on-track
      // overlap anywhere (two loops + a junction link, nothing crossing itself).
      await expect(sim.getByText(/track pieces overlap/)).toHaveCount(0);

      // Commission everything, then one train on Loop A.
      for (const id of allPieces) {
        await scanPiece(sim, id);
        await sim.waitForTimeout(40);
      }
      const trainPiece = await placePieceOnToyTable(sim, {
        type: 'train',
        xMm: loopA.trainAt.x,
        yMm: loopA.trainAt.y,
        flip: true,
      });
      await scanPiece(sim, trainPiece);
      const train = `T-${trainPiece}`;

      // Watch which markers the train crosses.
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

      // Throw BOTH junctions to DIVERT so a circulating train takes the branch
      // across the link into the other loop — the junctions route it between loops.
      bus.publish(
        topics.command(`SWITCH-${loopA.junction}`),
        setSwitchCommand(loopA.junction, 'divert'),
      );
      bus.publish(
        topics.command(`SWITCH-${loopB.junction}`),
        setSwitchCommand(loopB.junction, 'divert'),
      );
      await sim.waitForTimeout(800);

      // Set the train running.
      bus.publish(topics.command(train), explorationCommand(train));

      // The proof: the single train crosses markers belonging to BOTH loops —
      // it has toured the whole map by routing through the junctions.
      const onA = (): number => loopA.markers.filter((m) => crossed.has(m)).length;
      const onB = (): number => loopB.markers.filter((m) => crossed.has(m)).length;
      for (let i = 0; i < 90 && (onA() < 3 || onB() < 3); i++) await sim.waitForTimeout(1000);

      await sim.screenshot({ path: resolve(shotDir, 'junction-traversal-running.png') });
      bus.disconnect();

      expect(onA(), 'the train should run round Loop A').toBeGreaterThanOrEqual(3);
      expect(
        onB(),
        'the train should cross the junction link and run round Loop B',
      ).toBeGreaterThanOrEqual(3);

      const video = sim.video();
      await sim.close();
      if (video !== null) await video.saveAs(resolve(videoDir, 'junction-traversal.webm'));
    });
  });
