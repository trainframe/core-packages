// @ts-check
/**
 * Record a HUMAN session on the toy-table so the exact pointer moves and the
 * resulting piece state can be read back (a video only lets you guess from
 * pixels; this logs the ground truth).
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/record-session.mjs
 *
 * Opens a real Chromium on the sim-ui dev server (:5274 — start it with
 * `pnpm --filter @trainframe/simulator-ui dev` if it isn't up; override with
 * TF_URL). Drive the track however you like — build, drag, flex, try to close a
 * loop. When you're done, CLOSE THE BROWSER WINDOW. The session is written to
 * packages/ui-tests/videos/session-log.jsonl (override with OUT) AND a video to
 * videos/session/.
 *
 * Each log line is one JSON event with a millisecond timestamp `t`:
 *   {ev:"down"|"up", cx,cy (client px), mm:{x,y} (world mm), pieces:[...], wave}
 *   {ev:"move", cx,cy, mm}              // only while a button is held, throttled
 *   {ev:"wave"}                         // a closure wave mounted
 * `pieces` is every placed piece: {id, tf (SVG transform), len, closeable}. So a
 * reader sees every drag's path + speed and exactly where each piece ended up,
 * whether the closure flashed, and whether the wave fired — no pixel-guessing.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const START_URL = process.env.TF_URL ?? 'http://localhost:5274/';
const OUT = process.env.OUT ?? new URL('../videos/session-log.jsonl', import.meta.url).pathname;
const VIDEO_DIR = new URL('../videos/session/', import.meta.url).pathname;
mkdirSync(VIDEO_DIR, { recursive: true });

const log = (m) => process.stderr.write(`[record] ${m}\n`);

const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
const ctx = await browser.newContext({ viewport: null, recordVideo: { dir: VIDEO_DIR } });
const page = await ctx.newPage();

const stream = createWriteStream(OUT, { flags: 'w' });
let lines = 0;
page.on('console', (msg) => {
  const t = msg.text();
  if (t.startsWith('SESSIONLOG ')) {
    stream.write(`${t.slice('SESSIONLOG '.length)}\n`);
    lines += 1;
  }
});

/* Injected BEFORE the app loads, on every navigation: hook pointer events and
   snapshot piece state. Everything is logged via console so the Node side can
   capture it even after the window closes. */
await page.addInitScript(() => {
  const CANVAS = '[data-testid="toy-table-canvas"]';
  const emit = (obj) =>
    // eslint-disable-next-line no-console
    console.log(`SESSIONLOG ${JSON.stringify({ t: Math.round(performance.now()), ...obj })}`);

  /** Client px → world mm via the SVG's screen CTM. */
  const toMm = (cx, cy) => {
    const svg = /** @type {SVGSVGElement|null} */ (document.querySelector(CANVAS));
    const ctm = svg?.getScreenCTM?.();
    if (!svg || !ctm) return null;
    const p = svg.createSVGPoint();
    p.x = cx;
    p.y = cy;
    const s = p.matrixTransform(ctm.inverse());
    return { x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10 };
  };

  /** Every placed piece: id, transform (translate+rotate), length, closeable flash. */
  const pieces = () =>
    [...document.querySelectorAll('[data-piece-id]')].map((el) => ({
      id: el.getAttribute('data-piece-id'),
      tf: el.getAttribute('transform'),
      len: el.getAttribute('data-length-mm') || undefined,
      closeable: el.getAttribute('data-closure-available') === 'true' || undefined,
    }));

  for (const ev of ['pointerdown', 'pointerup']) {
    document.addEventListener(
      ev,
      (e) => {
        const pe = /** @type {PointerEvent} */ (e);
        emit({
          ev: ev === 'pointerdown' ? 'down' : 'up',
          cx: Math.round(pe.clientX),
          cy: Math.round(pe.clientY),
          mm: toMm(pe.clientX, pe.clientY),
          wave: !!document.querySelector('[data-testid="closure-wave"]'),
          pieces: pieces(),
        });
      },
      true,
    );
  }

  /* Throttled move logging — only while a button is held (a drag). */
  let last = 0;
  document.addEventListener(
    'pointermove',
    (e) => {
      const pe = /** @type {PointerEvent} */ (e);
      const now = performance.now();
      if (pe.buttons !== 0 && now - last > 35) {
        last = now;
        emit({
          ev: 'move',
          cx: Math.round(pe.clientX),
          cy: Math.round(pe.clientY),
          mm: toMm(pe.clientX, pe.clientY),
        });
      }
    },
    true,
  );

  /* Note when a closure wave mounts. */
  const obs = new MutationObserver(() => {
    if (document.querySelector('[data-testid="closure-wave"]')) emit({ ev: 'wave' });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
});

await page.goto(START_URL);
log(`recording from ${START_URL} — drive the track, then CLOSE THE WINDOW to finish.`);
await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
stream.end();
await ctx.close().catch(() => {});
await browser.close().catch(() => {});
log(`wrote ${lines} events to ${OUT}`);
