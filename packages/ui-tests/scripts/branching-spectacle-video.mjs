// @ts-check
/**
 * Record the live BRANCHING RAILYARD SPECTACLE in Chrome.
 *
 * The Node side here runs ONLY the harness: an in-process aedes broker + the real
 * `@trainframe/server` scheduler, on a free WS port, against the branching layout
 * (the physics scene compiled to the protocol `Layout`). It builds NO devices and
 * NO physics world — the BROWSER owns those. The simulator-ui DEV page is opened at
 * `?physics=branching` with `localStorage` pointed at the harness broker, so the
 * browser builds the REAL `buildBranchingDemo` device side (one physics world +
 * `ScheduledTrainDevice` per loco + the `Jspur` `SwitchDevice` + the
 * `YardZoneDevice`) over `mqttPlatform`, registers on the bus, and steps the world
 * each frame.
 *
 * Once every device has registered, this script assigns each train its cyclic
 * schedule from the exported `DEMO_ROUTES` (FROZEN SPEC §8): T1 the express, T2 a
 * yard turn, T3 the branch local, T4 the yard reliever queueing behind T2. (A
 * `ScheduledTrainDevice` seeds its heading from its route's first edge — the home
 * stop its body is parked at — so the planner routes it the correct way the moment
 * the route lands; it cannot declare a heading BEFORE a route, so registration is
 * the right gate, exactly as the headless integration gate assigns.) The scheduler
 * then routes, clears and resolves switches; the browser renders the trains it
 * drives. Records the whole run to one MP4.
 *
 *   node packages/ui-tests/scripts/branching-spectacle-video.mjs
 *
 * Prereq: a simulator-ui vite DEV server (TF_SIM_URL, default http://localhost:5274).
 * Needs ffmpeg. Output: videos/spectacle/branching-spectacle.mp4.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { MqttBrokerClient } from '@trainframe/server';
import {
  DEMO_ROUTES,
  SPUR_SWITCH_ID,
  YARD_DEVICE_ID,
  buildBranchingScene,
  sceneToLayout,
} from '@trainframe/simulator';
import { startUiHarness } from '../src/test-harness.ts';

const SIM = process.env.TF_SIM_URL ?? 'http://localhost:5274';
const WS_PORT = Number(process.env.TF_WS_PORT ?? 9112);
const OUT = new URL('../videos/spectacle/', import.meta.url).pathname;
const RECORD_S = Number(process.env.TF_RECORD_S ?? 120);
const STEP_MS = 1000 / 60;
const W = 1920;
const H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[branching] ${m}\n`);

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  /* Harness = aedes broker + the real server scheduler, on a free WS port. The
     layout is the branching physics scene compiled to the protocol Layout. We
     build only the layout here — no world, no devices (the browser owns those). */
  const layout = sceneToLayout(buildBranchingScene(3), 'branching');
  const trainIds = [...DEMO_ROUTES.keys()];
  log(
    `layout: ${layout.markers.length} markers, ${layout.edges.length} edges; ${trainIds.length} trains`,
  );
  const harness = await startUiHarness({ layout, wsPort: WS_PORT });
  log(`harness broker ${harness.brokerWsUrl}, scheduler up`);

  /* Pump the harness clock so the scheduler's dwell/clearance timing advances with
     wall time. (The browser steps the physics world; this only drives core's
     virtual clock.) */
  const ticker = setInterval(() => harness.advance(STEP_MS), STEP_MS);

  /* Wait for every device to register before scheduling — the devices live in the
     BROWSER; we observe their `device_registered` events on the bus. (A
     `ScheduledTrainDevice` only declares a heading AFTER it has a route, so the
     route assignment is what seeds its facing; registration is the right gate.) */
  const required = new Set([YARD_DEVICE_ID, SPUR_SWITCH_ID, ...trainIds]);
  const seen = new Set();
  let scheduled = false;
  const watch = new MqttBrokerClient();
  await watch.connect(harness.brokerWsUrl);
  const trySchedule = () => {
    if (scheduled || seen.size < required.size) return;
    scheduled = true;
    for (const [id, route] of DEMO_ROUTES) {
      harness.server.assignSchedule(id, route.routeId, [...route.stops]);
    }
    log('schedules assigned — express, yard turn, branch local, yard reliever');
  };
  watch.subscribe('railway/events/device_registered/+', (msg) => {
    const id = msg.topic.split('/').pop();
    if (id && required.has(id) && !seen.has(id)) {
      seen.add(id);
      log(`registered ${id} (${seen.size}/${required.size})`);
      trySchedule();
    }
  });

  /* The browser = the DEVICE + RENDER side, pointed at the same broker. */
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  await context.addInitScript((broker) => {
    localStorage.setItem('trainframe.simulator-ui.brokerUrl', broker);
  }, harness.brokerWsUrl);
  const page = await context.newPage();
  await page.goto(`${SIM}?physics=branching`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.__tfFitView === 'function', undefined, {
    timeout: 15000,
  });
  /* Let the device-side demo build + register, then frame the whole layout. */
  await sleep(800);
  await page.evaluate(() => window.__tfFitView?.());
  log('scene framed; waiting for schedules then recording…');

  await sleep(RECORD_S * 1000);
  if (!scheduled) log('WARNING: schedules never assigned (a device or heading never arrived)');
  await page.screenshot({ path: `${OUT}branching-spectacle-end.png` });
  const video = page.video();
  clearInterval(ticker);
  await context.close();
  await browser.close();
  watch.disconnect();
  await harness.shutdown();

  if (!video) throw new Error('no video captured');
  const webm = `${OUT}branching-spectacle.webm`;
  renameSync(await video.path(), webm);
  const mp4 = `${OUT}branching-spectacle.mp4`;
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    webm,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '20',
    mp4,
  ]);
  log(`=== branching spectacle → ${mp4} (scheduled=${scheduled}) ===`);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
