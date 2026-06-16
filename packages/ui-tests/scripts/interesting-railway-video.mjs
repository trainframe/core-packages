// @ts-check
/**
 * Record the live 4-TRAIN INTERESTING-RAILWAY demo in Chrome.
 *
 * Node side runs ONLY the harness: an in-process aedes broker + the real
 * `@trainframe/server` scheduler on a free WS port, against the interesting layout. It
 * builds NO devices and NO world — the BROWSER owns those, via `?physics=interesting-demo`
 * (`buildInterestingRailwayDemo` over `mqttPlatform`). Once every device registers, this
 * assigns the four schedules — T1 calls at the YARD (its carriages are swapped on-rail),
 * the others circulate — and records the run to one MP4.
 *
 *   node packages/ui-tests/scripts/interesting-railway-video.mjs
 *
 * Prereq: a simulator-ui vite DEV server (TF_SIM_URL, default http://localhost:5274).
 * Needs ffmpeg. Output: videos/spectacle/interesting-railway.mp4.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { MqttBrokerClient } from '@trainframe/server';
import {
  INTERESTING_MARKERS as M,
  INTERESTING_YARD_DEVICE_ID,
  buildMainLoopScene,
  interestingToLayout,
} from '../../simulator-ui/src/demo/index.ts';
import { startUiHarness } from '../src/test-harness.ts';

const SIM = process.env.TF_SIM_URL ?? 'http://localhost:5274';
const WS_PORT = Number(process.env.TF_WS_PORT ?? 9113);
const OUT = new URL('../videos/spectacle/', import.meta.url).pathname;
const RECORD_S = Number(process.env.TF_RECORD_S ?? 150);
const STEP_MS = 1000 / 60;
const W = 1920;
const H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[interesting] ${m}\n`);

/** The four schedules: T1 calls at the yard (swap), the others circulate. */
const SCHEDULES = [
  { id: 'T1', routeId: 'r1-yard', stops: [M.north, M.east, M.yard, M.south] },
  { id: 'T2', routeId: 'r2', stops: [M.satAStation, M.south, M.north] },
  { id: 'T3', routeId: 'r3', stops: [M.east, M.north, M.south] },
  { id: 'T4', routeId: 'r4', stops: [M.south, M.west, M.north] },
];
const REQUIRED = new Set([
  'T1',
  'T2',
  'T3',
  'T4',
  'SWITCH-M-satA-jn',
  'SWITCH-M-satB-jn',
  'SWITCH-M-yard-jn',
  INTERESTING_YARD_DEVICE_ID,
]);

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const layout = interestingToLayout(buildMainLoopScene());
  log(`layout: ${layout.markers.length} markers, ${layout.edges.length} edges`);
  const harness = await startUiHarness({ layout, wsPort: WS_PORT });
  log(`harness broker ${harness.brokerWsUrl}, scheduler up`);

  /* Advance core's virtual clock with wall time (dwell/clearance timing). */
  const ticker = setInterval(() => harness.advance(STEP_MS), STEP_MS);

  const seen = new Set();
  let scheduled = false;
  const watch = new MqttBrokerClient();
  await watch.connect(harness.brokerWsUrl);
  const trySchedule = () => {
    if (scheduled || seen.size < REQUIRED.size) return;
    scheduled = true;
    for (const s of SCHEDULES) harness.server.assignSchedule(s.id, s.routeId, s.stops);
    log('schedules assigned — T1 to the yard, T2/T3/T4 circulating');
  };
  watch.subscribe('railway/events/device_registered/+', (msg) => {
    const id = msg.topic.split('/').pop();
    if (id && REQUIRED.has(id) && !seen.has(id)) {
      seen.add(id);
      log(`registered ${id} (${seen.size}/${REQUIRED.size})`);
      trySchedule();
    }
  });

  /* Browser = the DEVICE + RENDER side, pointed at the same broker. */
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  await context.addInitScript((broker) => {
    localStorage.setItem('trainframe.simulator-ui.brokerUrl', broker);
  }, harness.brokerWsUrl);
  const page = await context.newPage();
  await page.goto(`${SIM}?physics=interesting-demo`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__tfPhysics?.name === 'interesting-demo', undefined, {
    timeout: 15000,
  });
  log('view live; recording…');

  await sleep(RECORD_S * 1000);
  if (!scheduled) log('WARNING: schedules never assigned (a device never registered)');
  await page.screenshot({ path: `${OUT}interesting-railway-end.png` });
  const video = page.video();
  clearInterval(ticker);
  await context.close();
  await browser.close();
  watch.disconnect();
  await harness.shutdown();

  if (!video) throw new Error('no video captured');
  const webm = `${OUT}interesting-railway.webm`;
  renameSync(await video.path(), webm);
  const mp4 = `${OUT}interesting-railway.mp4`;
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
  log(`=== interesting railway → ${mp4} (scheduled=${scheduled}) ===`);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
