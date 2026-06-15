// @ts-check
/**
 * Record a video of the "interesting" layout (`?physics=interesting`): a winding
 * main loop of real pieces that bridges OVER itself once, a lapping train riding the
 * flyover, and the bottom-left yard where a gantry crane swaps a parked train's rear
 * carriages for the spares — on a loop.
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/interesting-layout-video.mjs
 *   TF_SECONDS=90 ... to tune length.
 *
 * Prereq: the sim-ui dev server on :5274 (no broker needed — the physics view is
 * standalone). The view auto-frames via its own viewBox, so no pan/zoom is required.
 */
import { mkdirSync, renameSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PAGE_URL = `${process.env.TF_URL ?? 'http://localhost:5274/'}?physics=interesting`;
const OUT_DIR = new URL('../videos/', import.meta.url).pathname;
const RECORD_MS = Number(process.env.TF_SECONDS ?? 90) * 1000;
const W = 1366;
const H = 820;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[vid] ${m}\n`);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT_DIR, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });

  /* Wait for the physics harness + a moving train. */
  await page.waitForFunction(() => (window.__tfPhysics?.bodies?.().length ?? 0) > 0, {
    timeout: 30_000,
  });
  await sleep(1500);
  await page.screenshot({ path: `${OUT_DIR}interesting-frame.png` });
  log('view framed; recording');

  /* Record, logging the lapping train's progress + each crane swap phase so we know
   *  the take captured both the movement and a service. */
  const end = Date.now() + RECORD_MS;
  let lastPhase = null;
  let swaps = 0;
  while (Date.now() < end) {
    const s = await page.evaluate(() => {
      const p = window.__tfPhysics;
      const t = p?.bodies?.().find((b) => b.id === 'T');
      return { phase: p?.phase ?? null, carrying: p?.carrying ?? false, seg: t?.segment ?? null };
    });
    if (s.phase !== lastPhase) {
      if (lastPhase === 'to-train' && s.phase === 'done') swaps += 1;
      log(`crane phase: ${s.phase} (carrying=${s.carrying}); train seg=${s.seg}`);
      lastPhase = s.phase;
    }
    await sleep(600);
  }
  log(`recorded ${RECORD_MS / 1000}s; crane swaps captured: ${swaps}`);

  const video = page.video();
  await context.close();
  if (video) {
    const src = await video.path();
    const dest = `${OUT_DIR}interesting-layout.webm`;
    renameSync(src, dest);
    log(`video → ${dest}`);
  }
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
