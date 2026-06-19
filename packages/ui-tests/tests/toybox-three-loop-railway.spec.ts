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
 * THE FULL HAND-BUILT RAILWAY: three loops connected by junctions, a railyard in
 * the mix, three trains all running — built piece-by-piece through the toy-table
 * UI (real snap+orient placement, real scan-box commissioning) and run over the
 * real `@trainframe/server` scheduler. Records a video of the running railway.
 *
 * Each loop is a stadium (two semicircles + two straights); one straight per loop
 * is an inline JUNCTION whose through leg is part of the loop (a train circulates
 * over it, points at rest) and whose branch leg is the physical CONNECTION to the
 * neighbouring loop. Three trains each circulate their own loop.
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

/** Endpoints of a placed piece, world space. */
async function endpointsOf(
  sim: import('@playwright/test').Page,
  id: string,
  type: TrackPiece['type'],
): Promise<XY[]> {
  return getEndpoints(await readPiece(sim, id, type)).map((e) => ({ x: e.x, y: e.y }));
}

/** The endpoint of `id` farthest from `from` — the open tip after a snap-join. */
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
    payload: { reason: 'three-loop-railway' },
  } as unknown as CoreEvent;
  return new TextEncoder().encode(JSON.stringify(env));
}

/**
 * Build a stadium loop whose bottom straight is an inline JUNCTION. Returns the
 * junction id, the loop's piece ids, its spare branch endpoint(s) (the open
 * connectors to neighbours), and a point on the loop to place a train.
 */
interface BuiltLoop {
  junction: string;
  pieces: string[];
  trainAt: XY;
  closureGap: number;
  /** Spare branch of the BOTTOM junction (off the circulation path) — a connector. */
  branchBottom: XY;
  /** Spare branch of the TOP junction, present only when `twoJunctions`. */
  branchTop?: XY;
}

/**
 * Build a horizontal stadium loop. The bottom side is an inline junction; the top
 * side is a second junction (when `twoJunctions`) or a plain straight. A junction's
 * trunk+through are collinear (the oval side a train circulates over, points at
 * rest); its branch is the SPARE leg — off the circulation path, so wiring a
 * connector onto it never disturbs the loop. The loop is placed by its bottom
 * junction's free position, so its bottom branch lands at a predictable point.
 */
async function buildStadiumLoop(
  sim: import('@playwright/test').Page,
  centre: XY,
  opts: { curveType?: TrackPiece['type']; twoJunctions?: boolean } = {},
): Promise<BuiltLoop> {
  const curveType = opts.curveType ?? 'curve-tight';
  const pieces: string[] = [];
  const junction = await placePieceOnToyTable(sim, {
    type: 'junction',
    xMm: centre.x,
    yMm: centre.y,
  });
  pieces.push(junction);
  const jEps = await endpointsOf(sim, junction, 'junction');
  const trunk = jEps[0];
  const through = jEps[1];
  const branchBottom = jEps[2];
  if (trunk === undefined || through === undefined || branchBottom === undefined)
    throw new Error('junction endpoints missing');

  let tip: XY = through;
  let prev: XY = { x: centre.x, y: centre.y };
  const chain = async (type: TrackPiece['type']): Promise<string> => {
    const id = await placePieceOnToyTable(sim, { type, xMm: tip.x, yMm: tip.y });
    pieces.push(id);
    const next = await farEndpoint(sim, id, type, prev);
    prev = tip;
    tip = next;
    return id;
  };
  for (let i = 0; i < 4; i++) await chain(curveType);
  // Top side: a second junction (its branch a second connector) or a plain straight.
  let branchTop: XY | undefined;
  let trainHost: string;
  if (opts.twoJunctions === true) {
    const topJ = await chain('junction');
    const topEps = await endpointsOf(sim, topJ, 'junction');
    const tb = topEps[2];
    if (tb !== undefined) branchTop = { x: tb.x, y: tb.y };
    // The train rides a curve, never a junction.
    trainHost = pieces[2] ?? topJ;
  } else {
    trainHost = await chain('straight');
  }
  for (let i = 0; i < 4; i++) await chain(curveType);

  const hostMid = await readPiece(sim, trainHost, 'curve-tight');
  return {
    junction,
    pieces,
    branchBottom: { x: branchBottom.x, y: branchBottom.y },
    ...(branchTop !== undefined ? { branchTop } : {}),
    trainAt: { x: hostMid.position.x, y: hostMid.position.y },
    closureGap: Math.hypot(tip.x - trunk.x, tip.y - trunk.y),
  };
}

interface BuiltRailway {
  allPieces: string[];
  trainAts: XY[];
  loops: BuiltLoop[];
  yard: string;
}

/**
 * Build the whole railway through the toy-table UI: the middle loop first (two
 * junctions, branches NW + SE), Loop 0 hung off its NW branch, a RAILYARD spliced
 * into the connector toward Loop 2, then Loop 2 — a diagonal of three loops joined
 * by junctions with the yard on the network. Returns every placed piece, a
 * train-placement point per loop, and the yard id.
 */
async function buildThreeLoopRailway(sim: import('@playwright/test').Page): Promise<BuiltRailway> {
  const allPieces: string[] = [];
  // A junction's branch sits at (+70.71, +70.71) from its free-placed centre.
  const BRANCH_OFF = 100 * Math.cos(Math.PI / 4);

  // Chain a connector off a junction's branch (straights continue its 45°
  // direction); the next loop is placed so its OWN branch lands on the open end —
  // joining branch-to-branch, OFF both loops' circulation paths.
  const connector = async (from: XY, straights: number): Promise<XY> => {
    let prev: XY = { x: from.x - 50, y: from.y - 50 };
    let tip = from;
    for (let i = 0; i < straights; i++) {
      const id = await placePieceOnToyTable(sim, { type: 'straight', xMm: tip.x, yMm: tip.y });
      allPieces.push(id);
      const next = await farEndpoint(sim, id, 'straight', prev);
      prev = tip;
      tip = next;
    }
    return tip;
  };
  const centreForBranchAt = (end: XY): XY => ({ x: end.x - BRANCH_OFF, y: end.y - BRANCH_OFF });

  const loop1 = await buildStadiumLoop(sim, { x: 1250, y: 950 }, { twoJunctions: true });
  allPieces.push(...loop1.pieces);

  const eTop = await connector(loop1.branchTop ?? loop1.branchBottom, 4);
  const loop0 = await buildStadiumLoop(sim, centreForBranchAt(eTop));
  allPieces.push(...loop0.pieces);

  const tip = await connector(loop1.branchBottom, 2);
  const yard = await placePieceOnToyTable(sim, { type: 'railyard', xMm: tip.x, yMm: tip.y });
  allPieces.push(yard);
  const yardEps = await endpointsOf(sim, yard, 'railyard');
  const yardEast = yardEps[1] ?? yardEps[0];
  if (yardEast === undefined) throw new Error('railyard endpoints missing');
  const eBot = await connector(yardEast, 1);
  const loop2 = await buildStadiumLoop(sim, centreForBranchAt(eBot));
  allPieces.push(...loop2.pieces);

  const loops = [loop0, loop1, loop2];
  return { allPieces, trainAts: loops.map((l) => l.trainAt), loops, yard };
}

/**
 * Commission the built railway (scan every piece, place + scan a train per loop),
 * set every train circulating via `begin_exploration`, and watch marker crossings
 * until all trains have lapped (or the deadline). Returns each train's id and its
 * highest single-marker visit count (≥2 ⇒ a full lap on a closed ring).
 */
async function commissionAndRun(
  sim: import('@playwright/test').Page,
  brokerWsUrl: string,
  allPieces: string[],
  trainAts: XY[],
): Promise<Array<{ id: string; laps: number }>> {
  for (const id of allPieces) {
    await scanPiece(sim, id);
    await sim.waitForTimeout(40);
  }
  const trains: string[] = [];
  for (const at of trainAts) {
    const tp = await placePieceOnToyTable(sim, { type: 'train', xMm: at.x, yMm: at.y });
    await scanPiece(sim, tp);
    trains.push(`T-${tp}`);
  }

  const visits = new Map<string, Map<string, number>>(trains.map((t) => [t, new Map()]));
  const bus = new MqttBrokerClient();
  bus.connect(brokerWsUrl);
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
        const m = visits.get(tid);
        if (m !== undefined) m.set(mk, (m.get(mk) ?? 0) + 1);
      }
    } catch {
      /* ignore */
    }
  });

  for (const t of trains) bus.publish(topics.command(t), explorationCommand(t));
  const lapsOf = (t: string): number => Math.max(0, ...(visits.get(t)?.values() ?? [0]));
  for (let i = 0; i < 90 && !trains.every((t) => lapsOf(t) >= 2); i++) {
    await sim.waitForTimeout(1000);
  }
  bus.disconnect();
  return trains.map((t) => ({ id: t, laps: lapsOf(t) }));
}

test.describe
  .serial('toybox: a complete three-loop railway, built by hand', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9113 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('three connected loops, three trains, all lapping — recorded', async ({ browser }) => {
      test.setTimeout(300_000);
      const videoDir = resolve(import.meta.dirname, '..', 'videos', 'three-loop-railway');
      mkdirSync(videoDir, { recursive: true });
      const shotDir = resolve(import.meta.dirname, '..', 'screenshots');
      mkdirSync(shotDir, { recursive: true });

      const sim = await openSimulatorUi(browser, {
        brokerUrl: harness.brokerWsUrl,
        recordVideoDir: videoDir,
      });
      await sim.setViewportSize({ width: 1280, height: 1000 });
      await waitForVisualiserConnected(sim);
      await zoomOut(sim, 30);

      // ── Build the whole connected railway through the toy-table UI. ──
      const { allPieces, trainAts, loops, yard } = await buildThreeLoopRailway(sim);
      for (const l of loops) {
        expect(l.closureGap, 'each loop should close exactly').toBeLessThan(20);
      }
      expect(yard, 'a railyard is in the mix').toBeTruthy();
      await sim.screenshot({ path: resolve(shotDir, 'three-loop-built.png') });

      // ── Commission + run all three trains, then snapshot the running railway. ──
      const results = await commissionAndRun(sim, harness.brokerWsUrl, allPieces, trainAts);
      await sim.screenshot({ path: resolve(shotDir, 'three-loop-running.png') });

      // Every one of the three trains laps its own loop on the connected network.
      for (const r of results) {
        expect(r.laps, `${r.id} should lap its loop`).toBeGreaterThanOrEqual(2);
      }

      // Finalise the video of the running railway.
      const video = sim.video();
      await sim.close();
      if (video !== null) await video.saveAs(resolve(videoDir, 'three-loop-railway.webm'));
    });
  });
