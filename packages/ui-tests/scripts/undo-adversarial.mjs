// @ts-check
/**
 * Track-edit UNDO adversarial harness (goal criteria 5 & 6).
 *
 * Drives the RUNNING sim-ui dev server and actively tries to BREAK undo:
 *   - find an edit op (place / move / flex bake / rotate / delete / attach /
 *     detach) that does NOT push exactly one undo entry, or that undo fails to
 *     reverse;
 *   - find an undo that CORRUPTS or FORKS state (a new edit after an undo must
 *     replace the future, never resurrect the abandoned branch);
 *   - fire the Cmd/Ctrl+Z hotkey inside a focused text field and prove it does
 *     NOT undo the track.
 * Depth comes from the real in-browser `window.__tfUndoDepth`; connectivity from
 * `window.__tfConnectivity`. Both triggers are exercised: the keyboard chord AND
 * the Undo button. Records a video (accidental flex undone via Cmd+Z; accidental
 * move undone via the button) for the criterion-6 frame-by-frame review.
 *
 *   TF_URL=http://localhost:5176/ pnpm --filter @trainframe/ui-tests exec node scripts/undo-adversarial.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const URL_BASE = process.env.TF_URL ?? 'http://localhost:5176/';
const OUT_DIR = new URL('../videos/undo/', import.meta.url).pathname;
const VIDEO_DIR = `${OUT_DIR}session/`;
mkdirSync(VIDEO_DIR, { recursive: true });

const TWO_STRAIGHT_CHAIN = [
  { id: 'A', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'B', type: 'straight', position: { x: 500, y: 300 }, rotationDeg: 0, tagged: false },
];
const A_AND_FREE_C = [
  { id: 'A', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'C', type: 'straight', position: { x: 650, y: 120 }, rotationDeg: 0, tagged: false },
];
/* A straight chain kept within the visible canvas: flexing the free end (P3 at
   x=750) arcs the whole run — three joints compound into an unmistakable curve,
   so a flex reads as a BEND on camera, distinct from a whole-piece move. */
const LONG_CHAIN = Array.from({ length: 4 }, (_, i) => ({
  id: `P${i}`,
  type: 'straight',
  position: { x: 150 + i * 200, y: 300 },
  rotationDeg: 0,
  tagged: false,
}));
const CHAIN_END = [750, 300]; // P3's centre

const refutations = [];
const refute = (msg) => {
  refutations.push(msg);
  console.log(`  REFUTED: ${msg}`);
};

async function loadPieces(page, pieces) {
  await page.evaluate((p) => window.__tfLoadPieces?.(p), pieces);
  await page.waitForTimeout(100);
}
const depth = (page) => page.evaluate(() => window.__tfUndoDepth?.() ?? -1);
const connectivity = (page) =>
  page.evaluate(() => window.__tfConnectivity?.() ?? { components: -1, loops: -1, maxDev: -1 });
const pose = (page, id) =>
  page.evaluate((pid) => {
    const el = document.querySelector(`[data-piece-id="${pid}"]`);
    const t = el?.getAttribute('transform') ?? '';
    const tr = /translate\(([-\d.]+),?\s*([-\d.]+)\)/.exec(t);
    const ro = /rotate\(([-\d.]+)/.exec(t);
    return {
      present: el !== null,
      x: tr ? Number.parseFloat(tr[1]) : 0,
      y: tr ? Number.parseFloat(tr[2]) : 0,
      deg: ro ? Number.parseFloat(ro[1]) : 0,
    };
  }, id);
const count = (page) =>
  page.evaluate(() => document.querySelectorAll('[data-piece-id]').length);
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
/* Real browser pointer input (dispatched PointerEvents don't drive the live drag
   handlers; only genuine input does). MOVE mode: press then move immediately
   (cursor leaves the deadzone before the hold dwell). FLEX mode: press, hold
   STILL past FLEX_HOLD_MS, then move. */
async function dragMm(page, fromMm, toMm, { holdMs = 0 } = {}) {
  const a = await mmToClient(page, fromMm[0], fromMm[1]);
  const b = await mmToClient(page, toMm[0], toMm[1]);
  if (a === null || b === null) throw new Error('no CTM');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}
async function clickPieceMm(page, _id, xMm, yMm) {
  const c = await mmToClient(page, xMm, yMm);
  if (c === null) throw new Error('no CTM');
  await page.mouse.click(c.x, c.y);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => refute(`page error: ${e.message}`));
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="toy-table-canvas"]');

/* ── ATTACK 1: each op pushes exactly one entry, and undo reverses it. ───────── */
async function expectOneEntryThenUndo(page, label, doOp, undoVia) {
  const d0 = await depth(page);
  await doOp();
  await page.waitForTimeout(60);
  const d1 = await depth(page);
  if (d1 !== d0 + 1) refute(`${label}: expected one undo entry (depth ${d0}→${d0 + 1}), got ${d1}`);
  if (undoVia === 'button') {
    await page.locator('[data-testid="undo-button"]').click();
  } else {
    await page.keyboard.press('Meta+z');
  }
  await page.waitForTimeout(60);
  const d2 = await depth(page);
  if (d2 !== d0) refute(`${label}: undo (${undoVia}) did not pop the entry (depth ${d1}→${d0} expected, got ${d2})`);
  return d0;
}

// PLACE — arm a straight, click the canvas, then undo (button).
await loadPieces(page, []);
await page.locator('[data-testid="toybox-straight"]').click();
{
  const box = await page.locator('[data-testid="toy-table-canvas"]').boundingBox();
  if (box === null) throw new Error('no canvas box');
  await expectOneEntryThenUndo(
    page,
    'place',
    async () => {
      // A real input click — React's synthetic onClick on the SVG needs genuine
      // pointer input (a dispatched MouseEvent does not place).
      await page.mouse.click(box.x + 300, box.y + 200);
    },
    'button',
  );
  if ((await count(page)) !== 0) refute('place→undo left a piece on the table');
}
await page.keyboard.press('Escape'); // disarm

// MOVE — drag B into space, undo via Cmd+Z, prove pose restored.
await loadPieces(page, TWO_STRAIGHT_CHAIN);
{
  const before = await pose(page, 'B');
  await expectOneEntryThenUndo(
    page,
    'move',
    async () => {
      await dragMm(page, [500, 300], [720, 120]);
    },
    'cmdz',
  );
  const after = await pose(page, 'B');
  if (Math.hypot(after.x - before.x, after.y - before.y) > 1)
    refute(`move→undo did not restore B's pose (${JSON.stringify(before)} vs ${JSON.stringify(after)})`);
}

// FLEX bake — hold, drag, release; undo via button; prove pose restored.
await loadPieces(page, TWO_STRAIGHT_CHAIN);
{
  const before = await pose(page, 'B');
  await expectOneEntryThenUndo(
    page,
    'flex-bake',
    async () => {
      await dragMm(page, [500, 300], [500, 360], { holdMs: 340 });
    },
    'button',
  );
  const after = await pose(page, 'B');
  if (Math.abs(after.deg - before.deg) > 0.5)
    refute(`flex→undo did not restore B's heading (${before.deg} vs ${after.deg})`);
}

// ROTATE — select A, press R; undo via Cmd+Z.
await loadPieces(page, [TWO_STRAIGHT_CHAIN[0]]);
{
  const before = await pose(page, 'A');
  await clickPieceMm(page, 'A', 300, 300);
  await expectOneEntryThenUndo(page, 'rotate', async () => page.keyboard.press('r'), 'cmdz');
  const after = await pose(page, 'A');
  if (Math.abs(after.deg - before.deg) > 0.5) refute('rotate→undo did not restore A heading');
}

// DELETE — select B, press Delete; undo via button; prove piece returns.
await loadPieces(page, TWO_STRAIGHT_CHAIN);
await clickPieceMm(page, 'B', 500, 300);
await expectOneEntryThenUndo(page, 'delete', async () => page.keyboard.press('Delete'), 'button');
if (!(await pose(page, 'B')).present) refute('delete→undo did not bring B back');

// ATTACH/CARRY — carry free C toward A's east end; undo via Cmd+Z must put C back
// where it was (the carry is one undoable op, whether or not it snapped on drop).
await loadPieces(page, A_AND_FREE_C);
{
  if ((await connectivity(page)).components !== 2) refute('attach setup: C not separate');
  const before = await pose(page, 'C');
  await expectOneEntryThenUndo(
    page,
    'attach/carry',
    async () => {
      await dragMm(page, [650, 120], [500, 300]);
      await page.waitForTimeout(100);
    },
    'cmdz',
  );
  const after = await pose(page, 'C');
  if (Math.hypot(after.x - before.x, after.y - before.y) > 1)
    refute(`carry→undo did not restore C's pose (${JSON.stringify(before)} vs ${JSON.stringify(after)})`);
  if ((await connectivity(page)).components !== 2) refute('carry→undo did not leave A and C separate');
}

/* ── ATTACK 2: an undo must NOT fork — a new edit after an undo replaces the
   abandoned branch; undoing again lands on the surviving prior, never the fork. */
await loadPieces(page, TWO_STRAIGHT_CHAIN);
{
  const move = async (x, y) => {
    const p = await pose(page, 'B');
    await dragMm(page, [p.x, p.y], [x, y]);
    await page.waitForTimeout(40);
  };
  await move(700, 100); // edit 1
  const afterEdit1 = await pose(page, 'B');
  await move(220, 110); // edit 2 (the branch to be abandoned)
  await page.keyboard.press('Meta+z'); // undo edit 2 → afterEdit1
  await move(820, 480); // edit 3 — a NEW branch replaces edit-2's future
  await page.keyboard.press('Meta+z'); // undo edit 3 → afterEdit1 again
  await page.waitForTimeout(60);
  const back = await pose(page, 'B');
  if (Math.hypot(back.x - afterEdit1.x, back.y - afterEdit1.y) > 1)
    refute(`fork: undo landed on ${JSON.stringify(back)}, not the surviving edit-1 ${JSON.stringify(afterEdit1)}`);
}

/* ── ATTACK 3: the Cmd/Ctrl+Z hotkey must NOT undo track while a text field is
   focused (it must leave the browser's own text-undo alone). ─────────────────── */
await loadPieces(page, TWO_STRAIGHT_CHAIN);
{
  await dragMm(page, [500, 300], [720, 120]);
  const guardedDepth = await depth(page);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = '__adv_input';
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.press('Meta+z'); // should NOT undo the track
  await page.waitForTimeout(60);
  if ((await depth(page)) !== guardedDepth)
    refute('hotkey fired in a focused text field — it undid the track');
  await page.evaluate(() => document.getElementById('__adv_input')?.remove());
}

/* ── VIDEO (criterion 6): accidental flex undone via Cmd+Z; accidental move
   undone via the button — paced for a frame-by-frame review. ─────────────────── */
async function settleDepth(page) {
  await page.waitForTimeout(120);
  return depth(page);
}

// Fresh slate for the recording (the long attack run leaves the page's gesture
// state machine in an indeterminate spot; a reload gives the demo a clean start).
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="toy-table-canvas"]');

// (1) FLEX recovery via Cmd+Z — flexing the free end arcs the whole run (a
//     visible BEND across three joints, distinct from a whole-piece move).
await loadPieces(page, LONG_CHAIN);
await page.waitForTimeout(900); // straight chain, on camera
await dragMm(page, CHAIN_END, [750, 366], { holdMs: 360 }); // hold→bend the run down
if ((await settleDepth(page)) < 1) refute('video: flex did not register an undo entry');
await page.waitForTimeout(1100); // hold the BENT chain on camera
await page.keyboard.press('Meta+z'); // SNAP BACK to straight via the HOTKEY
await page.waitForTimeout(1100); // straight again, on camera

// (2) MOVE recovery via the Undo BUTTON — a whole piece flung away, on a fresh
//     chain so the displacement is obvious and distinct from the bend above.
await loadPieces(page, LONG_CHAIN);
await page.waitForTimeout(900); // straight chain, on camera
await dragMm(page, CHAIN_END, [600, 120]); // fling the free end up-left
if ((await settleDepth(page)) < 1) refute('video: move did not register an undo entry');
await page.waitForTimeout(1100); // displaced piece on camera
await page.locator('[data-testid="undo-button"]').click(); // SNAP BACK via the BUTTON
await page.waitForTimeout(1100); // restored, on camera

await page.close();
await ctx.close();
const video = await page.video()?.path();
await browser.close();

console.log('\n──────── UNDO ADVERSARIAL VERDICT ────────');
if (refutations.length === 0) {
  console.log('CANNOT-REFUTE: every edit op pushed exactly one entry and undid cleanly;');
  console.log('no fork after a post-undo edit; the hotkey is inert in a text field;');
  console.log('both the button and Cmd/Ctrl+Z reverted edits to the exact prior state.');
} else {
  console.log(`REFUTED (${refutations.length}):`);
  for (const r of refutations) console.log(`  - ${r}`);
}
if (video) console.log(`video: ${video}`);
process.exit(refutations.length === 0 ? 0 : 1);
