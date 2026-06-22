// @ts-check
/**
 * Adversarial connection harness (goal criteria 5 & 6).
 *
 * Drives the RUNNING sim-ui dev server (default localhost:5274) against the
 * authoritative-connection invariant, trying to make the rendered track LIE:
 *   - a false connect (rendered seated but not jointed),
 *   - a false disconnect (a piece severed by ordinary dragging),
 *   - an over-bent joint (kinked past the flex budget),
 *   - the closure wave firing without a real geometric cycle.
 *
 * For every drag frame it reconstructs the pieces from the rendered DOM and runs
 * the REAL buildJoints / connectedComponents / findLoops, comparing the rendered
 * geometry to the geometric joint graph. It also records a video of the exact
 * logged 7-curve loop-close attempt (criterion 6).
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/adversarial-connection.mjs
 *
 * Output (under packages/ui-tests/videos/adversarial/):
 *   - report.json        — per-attack invariant results + verdicts
 *   - session/*.webm      — the recorded 7-curve scenario video
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

/* Mirrors FLEX_BUDGET_DEG in @trainframe/simulator (a plain node script can't
   import the package's TS source; the metrics themselves come from the real
   in-browser buildJoints/connectedComponents/findLoops via window.__tfConnectivity). */
const FLEX_BUDGET_DEG = 5;

const URL_BASE = process.env.TF_URL ?? 'http://localhost:5274/';
const OUT_DIR = new URL('../videos/adversarial/', import.meta.url).pathname;
const VIDEO_DIR = `${OUT_DIR}session/`;
mkdirSync(VIDEO_DIR, { recursive: true });

/* The exact logged 7-curve arc (315°, one curve short of a loop). */
const SEVEN_CURVE_ARC = [
  {
    id: 'curve-1',
    type: 'curve',
    position: { x: 372.8785357737105, y: 121.9178972545757 },
    rotationDeg: 0,
    tagged: false,
  },
  {
    id: 'curve-3',
    type: 'curve',
    position: { x: 481.1177558029499, y: 230.15711728381513 },
    rotationDeg: 45,
    tagged: false,
  },
  {
    id: 'curve-4',
    type: 'curve',
    position: { x: 481.11775580294983, y: 383.23049022985106 },
    rotationDeg: 90,
    tagged: false,
  },
  {
    id: 'curve-5',
    type: 'curve',
    position: { x: 372.8785357737104, y: 491.46971025909045 },
    rotationDeg: 135,
    tagged: false,
  },
  {
    id: 'curve-6',
    type: 'curve',
    position: { x: 219.8051628276746, y: 121.9178972545757 },
    rotationDeg: 315,
    tagged: false,
  },
  {
    id: 'curve-7',
    type: 'curve',
    position: { x: 111.56594279843522, y: 230.15711728381513 },
    rotationDeg: 270,
    tagged: false,
  },
  {
    id: 'curve-8',
    type: 'curve',
    position: { x: 111.56594279843522, y: 383.23049022985106 },
    rotationDeg: 225,
    tagged: false,
  },
];

const DRAG_PATH = [
  [106.9, 386.7],
  [89.3, 382.9],
  [66.7, 375.1],
  [35.8, 363.9],
  [-0.3, 343.7],
  [-13.1, 337.3],
  [-33.4, 327.8],
  [-36.5, 299.5],
  [-28.4, 255.4],
  [-4.9, 234.5],
  [9.8, 218.4],
  [26.7, 202.7],
  [33, 200.2],
  [18.3, 232.7],
  [13.7, 273.5],
  [7.6, 314.2],
  [-7.9, 377.2],
  [-12.5, 385],
  [-4.6, 390.7],
  [0.3, 399.6],
];

/* Authoritative-connection metrics for the RENDERED geometry, computed in-browser
   by the real buildJoints / connectedComponents / findLoops. */
async function connectivity(page) {
  const m = await page.evaluate(() => window.__tfConnectivity?.() ?? null);
  if (m === null) throw new Error('window.__tfConnectivity unavailable (not a DEV build?)');
  return m;
}

/* World mm → client px via the canvas SVG screen CTM. */
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

async function loadArc(page) {
  await page.evaluate((pieces) => window.__tfLoadPieces?.(pieces), SEVEN_CURVE_ARC);
  await page.waitForTimeout(150);
}

async function disarm(page) {
  /* Click the armed toybox tile off so a press on a piece drags (not places). */
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const armed = btns.find((b) => b.getAttribute('aria-pressed') === 'true');
    armed?.click();
  });
}

async function waveMounted(page) {
  return (await page.locator('[data-testid="closure-wave"]').count()) > 0;
}

/* Rendered transform of one piece (mm + deg), for drag-engagement diagnostics. */
async function piecePose(page, id) {
  return page.evaluate((pid) => {
    const el = document.querySelector(`[data-piece-id="${pid}"]`);
    const t = el?.getAttribute('transform') ?? '';
    const tr = /translate\(([-\d.]+),?\s*([-\d.]+)\)/.exec(t);
    const ro = /rotate\(([-\d.]+)/.exec(t);
    return {
      x: tr ? Number.parseFloat(tr[1]) : null,
      y: tr ? Number.parseFloat(tr[2]) : null,
      deg: ro ? Number.parseFloat(ro[1]) : null,
    };
  }, id);
}

/* Dispatch a pointer event DIRECTLY on piece `id`'s group (bypasses hit-testing,
   which misses a curve's concave bounding box) with an explicit monotonic
   timeStamp. Mirrors the deterministic jsdom drag path. */
async function dispatchPtr(page, id, type, clientX, clientY, t) {
  await page.evaluate(
    ({ id, type, x, y, t }) => {
      const el = document.querySelector(`[data-piece-id="${id}"]`);
      if (el === null) throw new Error(`no element ${id}`);
      const e = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
        pointerId: 1,
      });
      Object.defineProperty(e, 'timeStamp', { value: t, configurable: true });
      el.dispatchEvent(e);
    },
    { id, type, x: clientX, y: clientY, t },
  );
}

/* Drive a drag that GRABS piece `id` and moves the cursor through a list of
   world-mm points (the cursor drives the dragged piece's free endpoint). */
async function drag(page, id, pointsMm, { fast = false } = {}) {
  const grab = await mmToClient(page, pointsMm[0][0], pointsMm[0][1]);
  if (!grab) throw new Error('no CTM');
  let t = fast ? 0 : 1000;
  await dispatchPtr(page, id, 'pointerdown', grab.x, grab.y, t);
  const frames = [];
  for (const [mx, my] of pointsMm) {
    const c = await mmToClient(page, mx, my);
    if (!c) continue;
    t += fast ? 4 : 200; /* slow: large dt ⇒ low speed; fast: tiny dt ⇒ high speed */
    await dispatchPtr(page, id, 'pointermove', c.x, c.y, t);
    /* Settle so the recorded video shows each flex frame distinctly (watchable). */
    if (!fast) await page.waitForTimeout(220);
    frames.push({ ...(await connectivity(page)), wave: await waveMounted(page) });
  }
  const last = await mmToClient(page, pointsMm.at(-1)[0], pointsMm.at(-1)[1]);
  await dispatchPtr(page, id, 'pointerup', last.x, last.y, t + 50);
  await page.waitForTimeout(80);
  return { frames, final: { ...(await connectivity(page)), wave: await waveMounted(page) } };
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

/* ---- Attack 1 (criterion 6 scenario): the logged 7-curve loop-close drag. ---- */
await loadArc(page);
await disarm(page);
const arcBaseline = (await connectivity(page)).components;
const c8Before = await piecePose(page, 'curve-8');
const a1 = await drag(page, 'curve-8', DRAG_PATH);
const c8After = await piecePose(page, 'curve-8');
report.dragEngagement = {
  curve8Before: c8Before,
  curve8After: c8After,
  movedMm:
    c8Before.x !== null && c8After.x !== null
      ? Math.hypot(c8After.x - c8Before.x, c8After.y - c8Before.y)
      : null,
  maxDevDuringDrag: Math.max(...a1.frames.map((f) => f.maxDev), 0),
};
report.attacks.push({
  name: '7-curve loop-close (logged drag) — must stay connected, never over-bend, never wave',
  baselineComponents: arcBaseline,
  ...a1,
  /* The 7-curve arc has no cycle: any frame that severed (components>baseline),
     over-bent (maxDev>budget), or fired the wave is a LIE. */
  refuted:
    a1.frames.some((f) => f.components !== arcBaseline) ||
    a1.frames.some((f) => f.maxDev > FLEX_BUDGET_DEG + 0.5) ||
    a1.frames.some((f) => f.wave) ||
    a1.final.components !== arcBaseline ||
    a1.final.wave ||
    a1.final.loops !== 0,
});

/* ---- Attack 2: a FAST, far yank of the open end — must not sever. ---- */
await loadArc(page);
await disarm(page);
const a2 = await drag(
  page,
  'curve-8',
  [
    [800, 700],
    [820, 720],
  ],
  { fast: true },
);
report.attacks.push({
  name: 'fast far yank of the open end — velocity gate removed, must not sever or wave-without-cycle',
  baselineComponents: arcBaseline,
  ...a2,
  refuted: a2.final.components > arcBaseline + 0 ? false : a2.final.wave || a2.final.loops !== 0,
  note: 'a fast far drag may legitimately re-place the piece as a free move; the LIE would be a wave/loop without a cycle, or an over-bent kink reported as connected',
  overBent:
    a2.frames.some((f) => f.maxDev > FLEX_BUDGET_DEG + 0.5) ||
    a2.final.maxDev > FLEX_BUDGET_DEG + 0.5,
});

/* ---- Attack 3: jerky multi-direction drag of the open end — must not over-bend. ---- */
await loadArc(page);
await disarm(page);
const a3 = await drag(page, 'curve-8', [
  [60, 360],
  [10, 300],
  [80, 260],
  [-20, 320],
  [120, 380],
  [40, 200],
  [90, 420],
  [0, 399.6],
]);
report.attacks.push({
  name: 'jerky multi-direction drag — joints must never over-bend; rendered == geometric',
  baselineComponents: arcBaseline,
  ...a3,
  refuted:
    a3.frames.some((f) => f.maxDev > FLEX_BUDGET_DEG + 0.5) ||
    a3.frames.some((f) => f.components < arcBaseline) ||
    a3.frames.some((f) => f.wave && f.loops === 0),
});

await page.waitForTimeout(200);
await ctx.close();
await browser.close();

report.summary = {
  anyRefuted: report.attacks.some((a) => a.refuted),
  budget: FLEX_BUDGET_DEG,
};
writeFileSync(`${OUT_DIR}report.json`, JSON.stringify(report, null, 2));
process.stderr.write(
  `[adversarial] wrote ${OUT_DIR}report.json — anyRefuted=${report.summary.anyRefuted}\n`,
);
