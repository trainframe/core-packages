// @ts-check
/**
 * Record the NEW RAILYARD up close — the metal gantry over the parallelogram of real
 * pieces, discovering its slots + the operator's stock, swapping a visiting train's
 * carriages on-rail. Same harness as the interesting-railway capture (aedes WS broker +
 * the real `@trainframe/server` scheduler; the browser owns the physics world + devices),
 * but T1 is routed to call at the YARD and the view is framed TIGHT on the railyard
 * (`?railyard`) so the swap fills the frame.
 *
 *   node packages/ui-tests/scripts/railyard-toybox-video.mjs
 *
 * Prereq: a simulator-ui vite DEV server (TF_SIM_URL). Needs ffmpeg.
 * Output: videos/spectacle/railyard-toybox.mp4.
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

const SIM = process.env.TF_SIM_URL ?? 'http://localhost:5174';
const WS_PORT = Number(process.env.TF_WS_PORT ?? 9117);
const OUT = new URL('../videos/spectacle/', import.meta.url).pathname;
const RECORD_S = Number(process.env.TF_RECORD_S ?? 190);
const STEP_MS = 1000 / 60;
const W = 1600;
const H = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[railyard] ${m}\n`);

/* T1 calls at the YARD each lap (swap + rotation); the others keep the line busy. */
const SCHEDULES = [
  { id: 'T1', routeId: 'r1y', stops: [M.north, M.yard, M.south] },
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
  const harness = await startUiHarness({ layout, wsPort: WS_PORT });
  log(`harness broker ${harness.brokerWsUrl}, scheduler up`);
  const ticker = setInterval(() => harness.advance(STEP_MS), STEP_MS);

  const seen = new Set();
  let scheduled = false;
  const watch = new MqttBrokerClient();
  await watch.connect(harness.brokerWsUrl);
  const trySchedule = () => {
    if (scheduled || seen.size < REQUIRED.size) return;
    scheduled = true;
    for (const s of SCHEDULES) harness.server.assignSchedule(s.id, s.routeId, s.stops);
    log('schedules assigned — T1 to the yard');
  };
  watch.subscribe('railway/events/device_registered/+', (msg) => {
    const id = msg.topic.split('/').pop();
    if (id && REQUIRED.has(id) && !seen.has(id)) {
      seen.add(id);
      trySchedule();
    }
  });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  await context.addInitScript((broker) => {
    localStorage.setItem('trainframe.simulator-ui.brokerUrl', broker);
  }, harness.brokerWsUrl);
  const page = await context.newPage();
  await page.goto(`${SIM}?physics=interesting-demo&railyard`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__tfPhysics?.name === 'interesting-demo', undefined, {
    timeout: 15000,
  });
  log('view live (framed on the yard); recording…');

  await sleep(RECORD_S * 1000);
  if (!scheduled) log('WARNING: schedules never assigned');
  await page.screenshot({ path: `${OUT}railyard-toybox-end.png` });
  const video = page.video();
  clearInterval(ticker);
  await context.close();
  await browser.close();
  watch.disconnect();
  await harness.shutdown();

  if (!video) throw new Error('no video captured');
  const webm = `${OUT}railyard-toybox.webm`;
  renameSync(await video.path(), webm);
  const mp4 = `${OUT}railyard-toybox.mp4`;
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
  log(`=== railyard → ${mp4} (scheduled=${scheduled}) ===`);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
