// @ts-check
/**
 * Capture the YARD INTERIOR choreography (ADR-029, 5-step): stage the railyard
 * demo, start the orchestrator (FIRST, so it catches the one-shot device
 * registrations) so this page's single train circulates to the yard, frame the
 * VIEW on the yard (fit, then zoom in centred on it), then poll the device's
 * interior maneuver and snap the viewport at each distinct phase.
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/railyard-yard-capture.mjs
 *
 * Prereqs: live-broker on 1883/9001 and the sim-ui dev server on :5274.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PAGE_URL = process.env.TF_URL ?? 'http://localhost:5274/';
const OUT_DIR = new URL('../videos/yard/', import.meta.url).pathname;
const YARD_DEVICE = 'YARD-yard';
const W = 1366;
const H = 820;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[cap] ${m}\n`);

/** Canvas viewBox + layout bbox (mm) + the yard piece's screen rect (px). */
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
    yard: yr
      ? { cx: yr.x + yr.width / 2, cy: yr.y + yr.height / 2, w: yr.width, h: yr.height }
      : null,
    n,
  };
}

/** Zoom out (real wheel) until the whole layout is comfortably in view, then pan
 *  (real drag from an empty corner) to centre it — both halves matter, or the
 *  layout sits off-screen. Mirrors railyard-video.mjs's proven fitView. */
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
  const dxMm = cxW - (g.vb[0] + g.vb[2] / 2);
  const dyMm = cyW - (g.vb[1] + g.vb[3] / 2);
  const dxPx = -(dxMm / g.vb[2]) * g.rect.w;
  const dyPx = -(dyMm / g.vb[3]) * g.rect.h;
  const startX = g.rect.x + 24;
  const startY = g.rect.y + 24;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dxPx, startY + dyPx, { steps: 8 });
  await page.mouse.up();
  await sleep(250);
}

/** Zoom IN centred on the yard so it fills the frame (zoom-to-cursor). */
async function zoomToYard(page, steps) {
  for (let i = 0; i < steps; i++) {
    const g = await page.evaluate(readGeometry);
    if (!g?.yard) break;
    await page.mouse.move(g.yard.cx, g.yard.cy);
    await page.mouse.wheel(0, -120); // negative = zoom in
    await sleep(140);
  }
}

function probe(dev) {
  const sim = window.trainframeSim?.getSimulation?.();
  if (!sim) return { ready: false };
  const yard = sim.getRailyard?.(dev);
  const t = sim.getTrain?.('T-amber');
  const e = t?.getCurrentEdge?.();
  return {
    ready: true,
    interior: yard?.getInteriorState?.() ?? null,
    occupancy: yard?.occupancy ?? null,
    consist: t?.getConsist?.()?.length ?? null,
    edge: e ? `${e.from_marker_id}->${e.to_marker_id}` : null,
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  spawn('pkill', ['-f', 'railyard-demo-server.mjs']);
  await sleep(800);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
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
  log('demo staged; framing on the yard');
  await fitView(page);
  await zoomToYard(page, 10);
  const g = await page.evaluate(readGeometry);
  log(
    `framed: yard at ${g?.yard ? `${Math.round(g.yard.cx)},${Math.round(g.yard.cy)} (${Math.round(g.yard.w)}px)` : 'unknown'}`,
  );

  const seen = new Set();
  const deadline = Date.now() + 260_000;
  let lastStep = null;
  let tick = 0;
  while (Date.now() < deadline && seen.size < 6) {
    const s = await page.evaluate(probe, YARD_DEVICE);
    const step = s.interior?.phase ?? null;
    if (tick % 12 === 0) {
      log(
        `edge=${s.edge ?? 'none'} occ=${s.occupancy} consist=${s.consist} interior=${step ?? '-'}`,
      );
    }
    if (step && step !== lastStep && !seen.has(step)) {
      seen.add(step);
      await page.screenshot({ path: `${OUT_DIR}phase-${seen.size}-${step}.png` });
      log(`captured ${step} (consist=${s.consist})`);
    }
    lastStep = step;
    tick += 1;
    await sleep(250);
  }
  await page.screenshot({ path: `${OUT_DIR}final.png` });
  log(`done; phases: [${[...seen].join(', ')}]`);
  orch.kill('SIGTERM');
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
