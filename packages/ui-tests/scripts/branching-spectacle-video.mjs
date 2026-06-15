// @ts-check
/**
 * Record the live BRANCHING RAILYARD SPECTACLE in Chrome.
 *
 * Boots the in-process harness (aedes broker + the real `@trainframe/server`
 * scheduler) on a free WS port, then builds the branching demo's ONE physics
 * world + its scheduler-driven devices ALL IN NODE over `mqttPlatform` on that
 * broker (the devices are DOM-free, so the same assembly the headless gate runs
 * drives the recording). A `setInterval` steps the world + the yard zone + every
 * train and pumps the harness clock. The simulator-ui DEV page is opened at
 * `?physics=branching` pointed at the same broker, so the browser renders the
 * world it reads off the bus while the Node scheduler owns routing, clearance and
 * the opaque yard.
 *
 * Once every device has registered and each train has declared a heading, the
 * four cyclic schedules (FROZEN SPEC §8) are assigned: T1 the express, T2 a yard
 * turn, T3 the branch local, T4 the yard reliever queueing behind T2. Records the
 * whole run to one MP4.
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
  MqttBrokerClient as SimMqttClient,
  buildBranchingDemo,
  mqttPlatform,
} from '../../simulator-ui/src/demo/index.ts';
import { startUiHarness } from '../src/test-harness.ts';

const SIM = process.env.TF_SIM_URL ?? 'http://localhost:5274';
const WS_PORT = Number(process.env.TF_WS_PORT ?? 9112);
const OUT = new URL('../videos/spectacle/', import.meta.url).pathname;
const RECORD_S = Number(process.env.TF_RECORD_S ?? 120);
const STEP_MS = 1000 / 60;
const DT_S = STEP_MS / 1000;
const W = 1920;
const H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[branching] ${m}\n`);

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  /* Harness = aedes broker + the real server scheduler, on a free WS port. The
     layout is the physics scene compiled to the protocol Layout. */
  const probe = buildBranchingDemo(() => mqttPlatform(new SimMqttClient(), 'probe'));
  const layout = probe.layout;
  log(`layout: ${layout.markers.length} markers, ${layout.edges.length} edges`);
  const harness = await startUiHarness({ layout, wsPort: WS_PORT });
  log(`harness broker ${harness.brokerWsUrl}, scheduler up`);

  /* The DEVICE side, IN NODE: one MQTT client per device over the harness broker.
     The browser only renders; these devices are the live citizens of core. */
  const deviceClients = [];
  const demo = buildBranchingDemo((deviceId) => {
    const client = new SimMqttClient();
    deviceClients.push(client);
    client.connect(harness.brokerWsUrl);
    return mqttPlatform(client, deviceId);
  });
  await sleep(500);
  demo.start();

  /* Step the world + zone + trains in real time; pump the harness clock so the
     scheduler's dwell/clearance timing advances with wall time. */
  const ticker = setInterval(() => {
    demo.step(DT_S);
    harness.advance(STEP_MS);
  }, STEP_MS);

  /* Wait for every device to register AND each train to declare a heading before
     scheduling — so the planner routes each the correct way round. */
  const required = new Set([demo.yardDeviceId, ...demo.switchDeviceIds, ...demo.trainIds]);
  const trainIds = new Set(demo.trainIds);
  const seen = new Set();
  const facing = new Set();
  let scheduled = false;
  const watch = new MqttBrokerClient();
  await watch.connect(harness.brokerWsUrl);
  const trySchedule = () => {
    if (scheduled || seen.size < required.size) return;
    if (![...trainIds].every((id) => facing.has(id))) return;
    scheduled = true;
    for (const [id, route] of demo.routes) {
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

  /* The browser = the RENDER side, pointed at the same broker. */
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
  await page.waitForFunction(() => typeof window.__tfLoadBranching === 'function', undefined, {
    timeout: 15000,
  });
  await page.evaluate(() => window.__tfLoadBranching?.());
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
  demo.stop();
  for (const c of deviceClients) c.disconnect();
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
