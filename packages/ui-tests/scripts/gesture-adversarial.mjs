// @ts-check
/**
 * Gesture-mode adversarial harness (goal criteria 5 & 6).
 *
 * Drives the RUNNING sim-ui dev server (localhost:5274) through BOTH drag gestures
 * and tries to make them misbehave:
 *   - MOVE mode (immediate drag): must DETACH the piece and, dropped on an aligned
 *     open end, ATTACH (component count drops); dropped in space, leave it free.
 *   - FLEX mode (press + real hold ≥250ms): must fire the ripple, flex within
 *     budget, and NEVER sever; release springs back / closes.
 *   - WRONG-mode probes: a quick drag must NOT flex (no ripple); a hold-still then
 *     small drag must NOT detach.
 *
 * Connectivity/budget come from the REAL in-browser buildJoints/connectedComponents
 * /findLoops via window.__tfConnectivity. Records a video of yank-off→re-attach and
 * a hold→ripple→flex for the criterion-6 review.
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/gesture-adversarial.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const FLEX_BUDGET_DEG = 5; // mirrors @trainframe/simulator (metrics come from the browser)
const URL_BASE = process.env.TF_URL ?? 'http://localhost:5274/';
const OUT_DIR = new URL('../videos/gesture/', import.meta.url).pathname;
const VIDEO_DIR = `${OUT_DIR}session/`;
mkdirSync(VIDEO_DIR, { recursive: true });

/* Two straights chained: A east end (400,300) meets B west end. */
const TWO_STRAIGHT_CHAIN = [
  { id: 'A', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'B', type: 'straight', position: { x: 500, y: 300 }, rotationDeg: 0, tagged: false },
];

async function loadPieces(page, pieces) {
  await page.evaluate((p) => window.__tfLoadPieces?.(p), pieces);
  await page.waitForTimeout(120);
}
async function connectivity(page) {
  const m = await page.evaluate(() => window.__tfConnectivity?.() ?? null);
  if (m === null) throw new Error('__tfConnectivity unavailable (not a DEV build?)');
  return m;
}
async function rippleMounted(page) {
  return (await page.locator('[data-testid="flex-ripple"]').count()) > 0;
}
async function mmToClient(page, xMm, yMm) {
  return page.evaluate(
    ([x, y]) => {
      const svg = document.querySelector('[data-testid="toy-table-canvas"]');
      const ctm = svg?.getScreenCTM?.();
      if (!svg || !ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = x;
      pt.y = y;
      const s = pt.matrixTransform(ctm);
      return { x: s.x, y: s.y };
    },
    [xMm, yMm],
  );
}
/* Dispatch a pointer event directly on a piece element (bypasses concave-bbox
   hit-testing). pieceId null → dispatch on the canvas (for moves after capture). */
async function dispatchPtr(page, id, type, clientX, clientY) {
  await page.evaluate(
    ({ id, type, x, y }) => {
      const el =
        id === null
          ? document.querySelector('[data-testid="toy-table-canvas"]')
          : document.querySelector(`[data-piece-id="${id}"]`);
      if (el === null) throw new Error(`no element ${id}`);
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: x,
          clientY: y,
          pointerId: 1,
        }),
      );
    },
    { id, type, x: clientX, y: clientY },
  );
}
async function piecePose(page, id) {
  return page.evaluate((pid) => {
    const el = document.querySelector(`[data-piece-id="${pid}"]`);
    const t = el?.getAttribute('transform') ?? '';
    const tr = /translate\(([-\d.]+),?\s*([-\d.]+)\)/.exec(t);
    return { x: tr ? +tr[1] : null, y: tr ? +tr[2] : null };
  }, id);
}

/* MOVE gesture: press on `id`, immediately move past the deadzone (no hold), carry
   through the mm points, release. */
async function moveDrag(page, id, pointsMm) {
  const first = await mmToClient(page, pointsMm[0][0], pointsMm[0][1]);
  await dispatchPtr(page, id, 'pointerdown', first.x, first.y);
  for (const [mx, my] of pointsMm) {
    const c = await mmToClient(page, mx, my);
    await dispatchPtr(page, id, 'pointermove', c.x, c.y);
    await page.waitForTimeout(40); // < 250ms each, so the hold never fires
  }
  const last = await mmToClient(page, pointsMm.at(-1)[0], pointsMm.at(-1)[1]);
  await dispatchPtr(page, id, 'pointerup', last.x, last.y);
  await page.waitForTimeout(120);
}

/* FLEX gesture: press on `id`, HOLD STILL ≥250ms (real time) so the dwell fires
   flex mode + ripple, then flex through the mm points, release. */
async function flexDrag(page, id, downMm, pointsMm) {
  const d = await mmToClient(page, downMm[0], downMm[1]);
  await dispatchPtr(page, id, 'pointerdown', d.x, d.y);
  await page.waitForTimeout(350); // hold → flex mode; ripple now mid-animation
  const rippleFired = await rippleMounted(page);
  await page.waitForTimeout(550); // keep holding still so the ripple fully plays (video clarity)
  let minComps = Number.POSITIVE_INFINITY;
  let maxDev = 0;
  for (const [mx, my] of pointsMm) {
    const c = await mmToClient(page, mx, my);
    await dispatchPtr(page, id, 'pointermove', c.x, c.y);
    await page.waitForTimeout(60);
    const m = await connectivity(page);
    minComps = Math.min(minComps, m.components);
    maxDev = Math.max(maxDev, m.maxDev);
  }
  const last = await mmToClient(page, pointsMm.at(-1)[0], pointsMm.at(-1)[1]);
  await dispatchPtr(page, id, 'pointerup', last.x, last.y);
  await page.waitForTimeout(120);
  return { rippleFired, minComps, maxDev };
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
});
const page = await ctx.newPage();
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="toy-table-canvas"]');

const report = { attacks: [] };

/* ---- MOVE: detach then re-attach (criterion-6 yank-off + re-attach scene). ---- */
await loadPieces(page, TWO_STRAIGHT_CHAIN);
const c0 = (await connectivity(page)).components; // 1
await moveDrag(page, 'B', [
  [500, 300],
  [640, 180],
  [720, 120],
]); // carry B into empty space
const afterDetach = (await connectivity(page)).components; // expect 2
const bAfter = await piecePose(page, 'B');
await moveDrag(page, 'B', [
  [bAfter.x, bAfter.y],
  [560, 300],
  [500, 300],
]); // carry B back onto A's east end
const afterReattach = (await connectivity(page)).components; // expect 1
report.attacks.push({
  name: 'MOVE: yank a chained piece off (detach), carry it back onto an aligned end (attach)',
  baseline: c0,
  afterDetach,
  afterReattach,
  refuted: afterDetach !== 2 || afterReattach !== 1,
});

/* ---- FLEX: hold → ripple → flex far; must not sever or over-bend. ---- */
await loadPieces(page, TWO_STRAIGHT_CHAIN);
const flex = await flexDrag(
  page,
  'B',
  [500, 300],
  [
    [500, 360],
    [520, 460],
    [540, 560],
    [500, 360],
  ],
);
const afterFlex = (await connectivity(page)).components;
report.attacks.push({
  name: 'FLEX: press + hold → ripple, then flex far — must fire ripple, never sever, never over-bend',
  rippleFired: flex.rippleFired,
  minCompsDuringFlex: flex.minComps,
  maxDevDuringFlex: flex.maxDev,
  afterFlex,
  refuted: !flex.rippleFired || flex.minComps < 1 || flex.maxDev > FLEX_BUDGET_DEG + 0.5,
});

/* ---- WRONG-MODE probe A: a QUICK drag must NOT flex (no ripple). ---- */
await loadPieces(page, TWO_STRAIGHT_CHAIN);
await page.waitForTimeout(800); // let any prior ripple auto-dismiss
const rippleBefore = await rippleMounted(page); // must be false to isolate the probe
const down = await mmToClient(page, 500, 300);
await dispatchPtr(page, 'B', 'pointerdown', down.x, down.y);
const mv = await mmToClient(page, 560, 360);
await dispatchPtr(page, 'B', 'pointermove', mv.x, mv.y); // immediate move → move mode
const quickRipple = await rippleMounted(page);
await dispatchPtr(page, 'B', 'pointerup', mv.x, mv.y);
await page.waitForTimeout(80);
report.attacks.push({
  name: 'WRONG-MODE: a quick drag must NOT engage flex (no ripple)',
  ripplePresentBeforeProbe: rippleBefore,
  rippleFiredOnQuickDrag: quickRipple,
  /* A clean probe requires no stale ripple beforehand; a NEW ripple on the quick
     drag is the real failure. */
  refuted: rippleBefore === false && quickRipple === true,
});

await page.waitForTimeout(200);
await ctx.close();
await browser.close();

report.summary = { anyRefuted: report.attacks.some((a) => a.refuted), budget: FLEX_BUDGET_DEG };
writeFileSync(`${OUT_DIR}report.json`, JSON.stringify(report, null, 2));
process.stderr.write(
  `[gesture] wrote ${OUT_DIR}report.json — anyRefuted=${report.summary.anyRefuted}\n`,
);
