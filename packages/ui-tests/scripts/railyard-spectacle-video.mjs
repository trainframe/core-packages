// @ts-check
/**
 * Record the live 4-TRAIN RAILYARD SPECTACLE in Chrome.
 *
 * Boots the in-process harness (aedes broker + the real `@trainframe/server`
 * scheduler) on a free WS port, opens the simulator-ui DEV toy-table in Chrome
 * pointed at that broker, seeds the railyard demo via `window.__tfLoadRailyardDemo()`
 * (DEV-only), waits for the four trains + the yard/turntable/lift-bridge devices to
 * register and declare a heading, then assigns each train its cyclic schedule. The
 * scheduler runs it: four trains circulate an intricate loop, pass through the
 * turntable + lift-bridge, and call at the yard where coloured carriages migrate
 * train→train. Records the whole thing to one MP4.
 *
 *   pnpm --filter @trainframe/ui-tests exec tsx scripts/railyard-spectacle-video.mjs
 *
 * Prereq: a simulator-ui vite DEV server (TF_SIM_URL, default http://localhost:5274).
 * Needs ffmpeg. Output: videos/spectacle/railyard-spectacle.mp4.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { MqttBrokerClient } from '@trainframe/server';
import { buildRailyardDemo } from '@trainframe/simulator/demo/railyard-demo.js';
import { compileLayout } from '../../simulator-ui/src/track/layout-from-pieces.ts';
import { startUiHarness } from '../src/test-harness.ts';

const SIM = process.env.TF_SIM_URL ?? 'http://localhost:5274';
const WS_PORT = Number(process.env.TF_WS_PORT ?? 9111);
const OUT = new URL('../videos/spectacle/', import.meta.url).pathname;
const RECORD_S = Number(process.env.TF_RECORD_S ?? 100);
const W = 1920;
const H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[spectacle] ${m}\n`);

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const demo = buildRailyardDemo();
  const layout = compileLayout(demo.pieces, 'railyard-demo');
  log(
    `layout: ${layout.markers.length} markers, ${layout.edges.length} edges; ${demo.trains.length} trains`,
  );

  /* Harness = aedes broker + the real server scheduler, on a free WS port. */
  const harness = await startUiHarness({ layout, wsPort: WS_PORT });
  log(`harness broker ${harness.brokerWsUrl}, scheduler up`);

  /* Wait for every device to register AND each train to declare a heading before
     scheduling — so the planner routes each the correct way round the one-way loop
     (mirrors railyard-demo-server.mjs). */
  const required = new Set([
    demo.yardDeviceId,
    demo.liftBridgeDeviceId,
    ...demo.switchDeviceIds,
    ...demo.trains.map((t) => t.deviceId),
  ]);
  const trainIds = new Set(demo.trains.map((t) => t.deviceId));
  const seen = new Set();
  const facing = new Set();
  let scheduled = false;
  const watch = new MqttBrokerClient();
  await watch.connect(harness.brokerWsUrl);
  const trySchedule = () => {
    if (scheduled || seen.size < required.size) return;
    if (![...trainIds].every((id) => facing.has(id))) return;
    scheduled = true;
    for (const t of demo.trains) {
      harness.server.assignSchedule(t.deviceId, `${t.deviceId}-loop`, t.stops);
    }
    log('schedules assigned — four trains circulating + calling at the yard');
  };
  watch.subscribe('railway/events/device_registered/+', (msg) => {
    const id = msg.topic.split('/').pop();
    if (id && required.has(id) && !seen.has(id)) {
      seen.add(id);
      log(`registered ${id} (${seen.size}/${required.size})`);
      trySchedule();
    }
  });
  watch.subscribe('railway/events/train_status/+', (msg) => {
    const id = msg.topic.split('/').pop();
    if (!id || !trainIds.has(id) || facing.has(id)) return;
    try {
      const edge = JSON.parse(new TextDecoder().decode(msg.payload))?.payload?.current_edge;
      if (edge) {
        facing.add(id);
        trySchedule();
      }
    } catch {
      /* ignore decode hiccups */
    }
  });

  /* The toy-table in Chrome = the device side, seeded with the demo. */
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  await context.addInitScript((broker) => {
    localStorage.setItem('trainframe.simulator-ui.brokerUrl', broker);
  }, harness.brokerWsUrl);
  const page = await context.newPage();
  await page.goto(SIM, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.__tfLoadRailyardDemo === 'function', undefined, {
    timeout: 15000,
  });
  await page.evaluate(() => window.__tfLoadRailyardDemo?.());
  /* Let the pieces render, then frame the whole layout in view. */
  await sleep(800);
  await page.evaluate(() => window.__tfFitView?.());
  log('demo seeded + framed; waiting for schedules then recording…');

  /* Record the run. */
  await sleep(RECORD_S * 1000);
  if (!scheduled) log('WARNING: schedules never assigned (a device or heading never arrived)');
  await page.screenshot({ path: `${OUT}spectacle-end.png` });
  const video = page.video();
  await context.close();
  await browser.close();
  watch.disconnect();
  await harness.shutdown();

  if (!video) throw new Error('no video captured');
  const webm = `${OUT}railyard-spectacle.webm`;
  renameSync(await video.path(), webm);
  const mp4 = `${OUT}railyard-spectacle.mp4`;
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
  log(`=== spectacle → ${mp4} (scheduled=${scheduled}) ===`);
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
