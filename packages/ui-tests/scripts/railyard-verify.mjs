// @ts-check
/**
 * Verify the railyard interior choreography: stage the demo, frame the yard,
 * then through ONE service trace the loco's on-screen position at ~40 ms (to
 * prove continuity at entry/exit — no teleport) and snap a yard-framed
 * screenshot at each distinct phase. Saves to videos/verify/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PAGE_URL = 'http://localhost:5274/';
const OUT = new URL('../videos/verify/', import.meta.url).pathname;
const YARD = 'YARD-yard';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[v] ${m}\n`);

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
  const cx = (g.bbox.minX + g.bbox.maxX) / 2;
  const cy = (g.bbox.minY + g.bbox.maxY) / 2;
  const dx = -((cx - (g.vb[0] + g.vb[2] / 2)) / g.vb[2]) * g.rect.w;
  const dy = -((cy - (g.vb[1] + g.vb[3] / 2)) / g.vb[3]) * g.rect.h;
  const sx = g.rect.x + 24;
  const sy = g.rect.y + 24;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx, sy + dy, { steps: 8 });
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
function probe(dev) {
  const sim = window.trainframeSim?.getSimulation?.();
  const phase = sim?.getRailyard?.(dev)?.getInteriorState?.()?.phase ?? null;
  const el = document.querySelector('[data-piece-id="amber"]');
  const m = (el?.getAttribute('transform') || '').match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
  const consist = sim?.getTrain?.('T-amber')?.getConsist?.()?.length ?? null;
  return { phase, loco: m ? { x: Math.round(+m[1]), y: Math.round(+m[2]) } : null, consist };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  spawn('pkill', ['-f', 'railyard-demo-server.mjs']);
  await sleep(800);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  const orch = spawn(
    'pnpm',
    ['--filter', '@trainframe/ui-tests', 'exec', 'tsx', 'scripts/railyard-demo-server.mjs'],
    { cwd: new URL('../', import.meta.url).pathname, stdio: 'inherit' },
  );
  await sleep(4000);
  await page.evaluate(() => window.__tfLoadRailyardDemo?.());
  await page.waitForFunction(
    (d) => {
      const s = window.trainframeSim?.getSimulation?.();
      return !!s && !!s.getRailyard?.(d) && !!s.getTrain?.('T-amber');
    },
    YARD,
    { timeout: 30000 },
  );
  await fitView(page);
  await zoomToYard(page, 8);
  log('framed; tracing one service');

  const seen = new Set();
  const pre = [];
  let sawService = false;
  let idleAfter = 0;
  let lastShot = null;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(probe, YARD);
    const line = `${s.phase ?? 'main'} ${s.loco ? `${s.loco.x},${s.loco.y}` : '?'} c=${s.consist}`;
    if (s.phase && !sawService) {
      sawService = true;
      for (const p of pre) log(`pre ${p}`);
    }
    if (sawService) {
      log(line);
      if (s.phase && s.phase !== lastShot && !seen.has(s.phase)) {
        seen.add(s.phase);
        await page.screenshot({ path: `${OUT}${seen.size}-${s.phase}.png` });
      }
      lastShot = s.phase;
      if (!s.phase) {
        idleAfter++;
        if (idleAfter > 40) break;
      } else {
        idleAfter = 0;
      }
    } else {
      pre.push(line);
      if (pre.length > 20) pre.shift();
    }
    await sleep(40);
  }
  log(`done; phases=[${[...seen].join(', ')}]`);
  orch.kill('SIGTERM');
  await browser.close();
}
main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
