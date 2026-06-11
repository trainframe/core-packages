// @ts-check
/**
 * INTERIOR TRACE — the close-up verification harness for the railyard
 * choreography (docs/spec/railyard-shunting-choreography.md). The single-train
 * video frames the whole loop, so the yard interior is a few px wide and the
 * choreography can't be judged. This harness instead:
 *
 *   1. stages the demo (orchestrator FIRST, one-shot device_registered),
 *   2. frames TIGHT on the yard (fills the viewport with the yard bbox),
 *   3. polls fast through ONE full service, recording for every sample the
 *      phase, the loco's rendered translate AND rotation (heading), and the
 *      consist length, and
 *   4. saves a screenshot every sample into videos/interior/.
 *
 * The heading trace is the point: the spec says the train must never face the
 * opposite way to the direction it came in. We capture the loco rotation each
 * tick and flag any sample whose heading is >100° from the entry heading, so a
 * 180° facing flip is provable from numbers, not just the eye.
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/railyard-interior-trace.mjs
 *
 * Prereqs: live-broker on 1883/9001 and the sim-ui dev server on :5274.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PAGE_URL = process.env.TF_URL ?? 'http://localhost:5274/';
const OUT = new URL('../videos/interior/', import.meta.url).pathname;
const YARD = 'YARD-yard';
const LOCO = process.env.TF_LOCO ?? 'amber';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[trace] ${m}\n`);

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

/** Zoom OUT (wheel only — no drag, which can grab a piece and corrupt the
 *  layout) until the whole layout fits, so the yard is on-screen. The per-shot
 *  clip then frames the yard tightly. */
async function fitView(page) {
  for (let i = 0; i < 22; i++) {
    const g = await page.evaluate(readGeometry);
    if (!g || g.n === 0) {
      await sleep(200);
      continue;
    }
    const bw = g.bbox.maxX - g.bbox.minX;
    const bh = g.bbox.maxY - g.bbox.minY;
    if (g.vb[2] >= bw * 1.25 && g.vb[3] >= bh * 1.25) break;
    await page.mouse.move(g.rect.x + g.rect.w / 2, g.rect.y + g.rect.h / 2);
    await page.mouse.wheel(0, 160);
    await sleep(140);
  }
  await sleep(200);
}

function probe(arg) {
  const { dev, loco } = arg;
  const sim = window.trainframeSim?.getSimulation?.();
  const interior = sim?.getRailyard?.(dev)?.getInteriorState?.() ?? null;
  const el = document.querySelector(`[data-piece-id="${loco}"]`);
  const tr = el?.getAttribute('transform') || '';
  const t = tr.match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
  const rot = tr.match(/rotate\(([-\d.]+)/);
  const consist = sim?.getTrain?.(`T-${loco}`)?.getConsist?.()?.length ?? null;
  return {
    phase: interior?.phase ?? null,
    progress: interior?.progress ?? null,
    swapping: interior?.swapping ?? null,
    entrySlotY: interior?.entrySlotY ?? null,
    sparesSlotY: interior?.sparesSlotY ?? null,
    loco: t ? { x: Math.round(+t[1]), y: Math.round(+t[2]) } : null,
    headingDeg: rot ? Math.round(+rot[1]) : null,
    consist,
  };
}

function angDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Map a world-space rectangle to a screen-pixel clip via the SVG viewBox→canvas
 *  transform, intersected with the canvas. */
function worldClip(g, w) {
  const sx = (x) => g.rect.x + ((x - g.vb[0]) / g.vb[2]) * g.rect.w;
  const sy = (y) => g.rect.y + ((y - g.vb[1]) / g.vb[3]) * g.rect.h;
  const x = Math.max(g.rect.x, sx(w.x0));
  const y = Math.max(g.rect.y, sy(w.y0));
  const right = Math.min(g.rect.x + g.rect.w, sx(w.x1));
  const bottom = Math.min(g.rect.y + g.rect.h, sy(w.y1));
  const width = right - x;
  const height = bottom - y;
  if (width <= 2 || height <= 2) return undefined;
  return { x, y, width, height };
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
    (a) => {
      const s = window.trainframeSim?.getSimulation?.();
      return !!s && !!s.getRailyard?.(a.dev) && !!s.getTrain?.(`T-${a.loco}`);
    },
    { dev: YARD, loco: LOCO },
    { timeout: 30000 },
  );
  await fitView(page);
  log('fitted; clipping each shot to the yard bbox; waiting for a service');

  const samples = [];
  let entryHeading = null;
  let shot = 0;
  let sawService = false;
  let idleAfter = 0;
  const deadline = Date.now() + 260000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(probe, { dev: YARD, loco: LOCO });
    if (s.phase && !sawService) {
      sawService = true;
      entryHeading = s.headingDeg;
      log(`service began — entry heading=${entryHeading}°`);
    }
    if (sawService) {
      if (s.phase) {
        shot += 1;
        const flip = entryHeading != null && s.headingDeg != null && angDiff(entryHeading, s.headingDeg) > 100;
        const tag = `${String(shot).padStart(3, '0')}-${s.phase}${flip ? '-FLIP' : ''}`;
        // Clip tight to the yard by mapping a FIXED interior world-bbox through
        // the live viewBox→screen transform (deterministic; the yard element's own
        // bbox includes the gantry and lands unreliably). World bbox covers the
        // spine + slots + leads the loco traverses, padded.
        const g = await page.evaluate(readGeometry);
        const clip = g
          ? worldClip(g, { x0: 560, y0: 1230, x1: 2000, y1: 1560 })
          : undefined;
        await page.screenshot(clip ? { path: `${OUT}${tag}.png`, clip } : { path: `${OUT}${tag}.png` });
        samples.push({ shot, ...s, flip });
        log(
          `${tag} prog=${(s.progress ?? 0).toFixed(2)} loco=${s.loco ? `${s.loco.x},${s.loco.y}` : '?'} head=${s.headingDeg}° consist=${s.consist}`,
        );
        idleAfter = 0;
      } else {
        idleAfter += 1;
        if (idleAfter > 30) break;
      }
    }
    await sleep(60);
  }

  const flips = samples.filter((s) => s.flip);
  const phases = [...new Set(samples.map((s) => s.phase))];
  writeFileSync(`${OUT}trace.json`, JSON.stringify({ entryHeading, phases, samples }, null, 2));
  log(`done — ${samples.length} samples, phases=[${phases.join(', ')}]`);
  log(`entry heading=${entryHeading}°; FLIP samples=${flips.length}`);
  if (flips.length) {
    const byPhase = {};
    for (const f of flips) byPhase[f.phase] = (byPhase[f.phase] ?? 0) + 1;
    log(`FLIP by phase: ${JSON.stringify(byPhase)}`);
  }
  orch.kill('SIGTERM');
  await browser.close();
}
main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
