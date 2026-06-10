// @ts-check
/**
 * Record a video (or grab a verification frame) of the railyard demo running on
 * the toy-table, with the whole layout framed.
 *
 * Prereqs: broker up, sim-ui dev server on :5274, and a FRESH
 * `scripts/railyard-demo-server.mjs` orchestrator (so it assigns schedules to
 * THIS page's trains).
 *
 *   MODE=verify pnpm --filter @trainframe/ui-tests exec node scripts/railyard-video.mjs
 *   MODE=record pnpm --filter @trainframe/ui-tests exec node scripts/railyard-video.mjs
 *
 * verify → frames the view, saves videos/frame.png, exits (cheap framing check).
 * record → frames the view, records ~60s into videos/, exits.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PAGE_URL = process.env.TF_URL ?? 'http://localhost:5274/';
const MODE = process.env.MODE ?? 'record';
const RECORD_MS = Number(process.env.TF_SECONDS ?? 60) * 1000;
const OUT_DIR = new URL('../videos/', import.meta.url).pathname;
const W = 1366;
const H = 820;

/** Read the canvas viewBox + the layout's piece bounding box (mm). */
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
  return {
    vb,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    bbox: { minX, minY, maxX, maxY },
    n,
  };
}

/** Zoom out (real wheel) until the window comfortably contains the layout, then
 *  pan (real drag from an empty corner) to centre it. Verified by viewBox math. */
async function fitView(page) {
  for (let i = 0; i < 14; i++) {
    const g = await page.evaluate(readGeometry);
    if (!g || g.n === 0) {
      await page.waitForTimeout(200);
      continue;
    }
    const bw = g.bbox.maxX - g.bbox.minX;
    const bh = g.bbox.maxY - g.bbox.minY;
    if (g.vb[2] >= bw * 1.18 && g.vb[3] >= bh * 1.18) break; // fits with margin
    await page.mouse.move(g.rect.x + g.rect.w / 2, g.rect.y + g.rect.h / 2);
    await page.mouse.wheel(0, 120); // one zoom-out step
    await page.waitForTimeout(140);
  }
  // Centre: drag from an empty corner by the world-offset mapped to pixels.
  const g = await page.evaluate(readGeometry);
  if (!g) return;
  const cxW = (g.bbox.minX + g.bbox.maxX) / 2;
  const cyW = (g.bbox.minY + g.bbox.maxY) / 2;
  const dxMm = cxW - (g.vb[0] + g.vb[2] / 2);
  const dyMm = cyW - (g.vb[1] + g.vb[3] / 2);
  const dxPx = -(dxMm / g.vb[2]) * g.rect.w;
  const dyPx = -(dyMm / g.vb[3]) * g.rect.h;
  const startX = g.rect.x + 24; // empty oval-corner of the canvas
  const startY = g.rect.y + 24;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dxPx, startY + dyPx, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    ...(MODE === 'record' ? { recordVideo: { dir: OUT_DIR, size: { width: W, height: H } } } : {}),
  });
  const page = await context.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__tfLoadRailyardDemo === 'function', null, {
    timeout: 15_000,
  });
  await page.evaluate(() => window.__tfLoadRailyardDemo());
  await page.waitForTimeout(9_000); // orchestrator sees headings + assigns

  await fitView(page);

  // Report the final framing so the caller can sanity-check from logs.
  const g = await page.evaluate(readGeometry);
  process.stdout.write(
    `framed: viewBox=${g?.vb.map((x) => Math.round(x)).join(' ')} bbox=${JSON.stringify(g?.bbox && { minX: Math.round(g.bbox.minX), minY: Math.round(g.bbox.minY), maxX: Math.round(g.bbox.maxX), maxY: Math.round(g.bbox.maxY) })}\n`,
  );

  if (MODE === 'verify') {
    await page.screenshot({ path: `${OUT_DIR}frame.png` });
    process.stdout.write(`verify frame → ${OUT_DIR}frame.png\n`);
  } else {
    await page.waitForTimeout(RECORD_MS);
  }
  await context.close();
  await browser.close();
  process.stdout.write('done\n');
}

main().catch((err) => {
  process.stderr.write(`railyard-video: ${err?.stack ?? err}\n`);
  process.exit(1);
});
