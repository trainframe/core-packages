// @ts-check
/**
 * Record a video of the SINGLE-TRAIN railyard demo: the train circulates the
 * loop and calls at the yard, where it runs the ADR-029 5-step interior
 * choreography. Starts the orchestrator FIRST (so it catches the one-shot device
 * registrations), stages the demo, frames the view, then records for TF_SECONDS.
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/railyard-single-video.mjs
 *   TF_SECONDS=140 ZOOM=3 ... to tune length / framing.
 *
 * Prereqs: live-broker on 1883/9001 and the sim-ui dev server on :5274.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PAGE_URL = process.env.TF_URL ?? 'http://localhost:5274/';
const OUT_DIR = new URL('../videos/', import.meta.url).pathname;
const RECORD_MS = Number(process.env.TF_SECONDS ?? 130) * 1000;
const ZOOM = Number(process.env.ZOOM ?? 2);
const YARD_DEVICE = 'YARD-yard';
const W = 1366;
const H = 820;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[vid] ${m}\n`);

function readGeometry() {
  const svg = document.querySelector('[data-testid="toy-table-canvas"]');
  if (!svg) return null;
  const vb = (svg.getAttribute('viewBox') || '0 0 900 400').split(' ').map(Number);
  const r = svg.getBoundingClientRect();
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1e9;
  let maxY = -1e9;
  let n = 0;
  for (const el of document.querySelectorAll('[data-piece-id]')) {
    const m = (el.getAttribute('transform') || '').match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
    if (m) {
      minX = Math.min(minX, +m[1]);
      minY = Math.min(minY, +m[2]);
      maxX = Math.max(maxX, +m[1]);
      maxY = Math.max(maxY, +m[2]);
      n++;
    }
  }
  const yardEl = document.querySelector('[data-piece-id="yard"]');
  const yr = yardEl?.getBoundingClientRect();
  return {
    vb,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    bbox: { minX, minY, maxX, maxY },
    yard: yr ? { cx: yr.x + yr.width / 2, cy: yr.y + yr.height / 2 } : null,
    n,
  };
}

async function fitView(page) {
  for (let i = 0; i < 16; i++) {
    const g = await page.evaluate(readGeometry);
    if (!g || g.n === 0) {
      await sleep(200);
      continue;
    }
    const bw = g.bbox.maxX - g.bbox.minX;
    const bh = g.bbox.maxY - g.bbox.minY;
    if (g.vb[2] >= bw * 1.18 && g.vb[3] >= bh * 1.18) break;
    await page.mouse.move(g.rect.x + g.rect.w / 2, g.rect.y + g.rect.h / 2);
    await page.mouse.wheel(0, 120);
    await sleep(140);
  }
  const g = await page.evaluate(readGeometry);
  if (!g) return;
  const cxW = (g.bbox.minX + g.bbox.maxX) / 2;
  const cyW = (g.bbox.minY + g.bbox.maxY) / 2;
  const dxPx = -((cxW - (g.vb[0] + g.vb[2] / 2)) / g.vb[2]) * g.rect.w;
  const dyPx = -((cyW - (g.vb[1] + g.vb[3] / 2)) / g.vb[3]) * g.rect.h;
  const sx = g.rect.x + 24;
  const sy = g.rect.y + 24;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dxPx, sy + dyPx, { steps: 8 });
  await page.mouse.up();
  await sleep(250);
}

async function zoomToYard(page, steps) {
  for (let i = 0; i < steps; i++) {
    const g = await page.evaluate(readGeometry);
    if (!g?.yard) break;
    await page.mouse.move(g.yard.cx, g.yard.cy);
    await page.mouse.wheel(0, -120);
    await sleep(140);
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  spawn('pkill', ['-f', 'railyard-demo-server.mjs']);
  await sleep(800);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });

  const orch = spawn(
    'pnpm',
    ['--filter', '@trainframe/ui-tests', 'exec', 'tsx', 'scripts/railyard-demo-server.mjs'],
    { cwd: new URL('../', import.meta.url).pathname, stdio: 'inherit' },
  );
  await sleep(4000);

  await page.evaluate(() => window.__tfLoadRailyardDemo?.());
  await page.waitForFunction(
    (dev) => {
      const sim = window.trainframeSim?.getSimulation?.();
      return !!sim && !!sim.getRailyard?.(dev) && !!sim.getTrain?.('T-amber');
    },
    YARD_DEVICE,
    { timeout: 30_000 },
  );
  log('demo staged; framing');
  await fitView(page);
  if (ZOOM > 0) await zoomToYard(page, ZOOM);
  await page.screenshot({ path: `${OUT_DIR}single-frame.png` }); // framing check

  // Record, logging laps + yard services so we know the take captured a maneuver.
  const end = Date.now() + RECORD_MS;
  let services = 0;
  let inMan = false;
  while (Date.now() < end) {
    const interior = await page.evaluate((dev) => {
      const sim = window.trainframeSim?.getSimulation?.();
      return sim?.getRailyard?.(dev)?.getInteriorState?.()?.phase ?? null;
    }, YARD_DEVICE);
    if (interior && !inMan) {
      inMan = true;
      services += 1;
      log(`yard service #${services} began (${interior})`);
    } else if (!interior && inMan) {
      inMan = false;
    }
    await sleep(500);
  }
  log(`recorded ${RECORD_MS / 1000}s; yard services captured: ${services}`);

  const video = page.video();
  await context.close(); // finalizes the webm
  orch.kill('SIGTERM');
  if (video) {
    const src = await video.path();
    const dest = `${OUT_DIR}railyard-single-train.webm`;
    renameSync(src, dest);
    log(`video → ${dest}`);
  }
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
