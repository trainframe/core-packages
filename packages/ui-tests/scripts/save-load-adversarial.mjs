// @ts-check
/**
 * Flex-readout + track save/load adversarial harness (goal criteria 6 & 7).
 *
 * Drives the RUNNING sim-ui dev server and actively tries to break:
 *   - the FLEX READOUT: a flex whose top-right readout doesn't live-update, or
 *     shows more/fewer than 2 decimals, or the wrong sign;
 *   - SAVE/LOAD: a round-trip that corrupts/drops pieces; a name collision that
 *     loses data; an autosave that fails to restore the track or undo on reload;
 *     a corrupt localStorage that wedges the editor.
 * Reads the live readout text and the in-browser `window.__tfUndoDepth` /
 * `__tfConnectivity`. Records a video (readout ticking live; save→build→load
 * returns; autosave reload preserving track + undo) for the criterion-7 review.
 *
 *   TF_URL=http://localhost:5177/ pnpm --filter @trainframe/ui-tests exec node scripts/save-load-adversarial.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const URL_BASE = process.env.TF_URL ?? 'http://localhost:5177/';
const VIDEO_DIR = new URL('../videos/save-load/session/', import.meta.url).pathname;
mkdirSync(VIDEO_DIR, { recursive: true });

const TWO_DP = /^-?\d+\.\d{2}°$/;
const CHAIN = [
  { id: 'A', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'B', type: 'straight', position: { x: 500, y: 300 }, rotationDeg: 0, tagged: false },
];
const SINGLE = [
  { id: 'X', type: 'straight', position: { x: 250, y: 200 }, rotationDeg: 0, tagged: false },
];

const refutations = [];
const refute = (m) => {
  refutations.push(m);
  console.log(`  REFUTED: ${m}`);
};

const loadPieces = async (page, pieces) => {
  await page.evaluate((p) => window.__tfLoadPieces?.(p), pieces);
  await page.waitForTimeout(120);
};
const depth = (page) => page.evaluate(() => window.__tfUndoDepth?.() ?? -1);
const poses = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-piece-id]')]
      .map((el) => {
        const t = el.getAttribute('transform') ?? '';
        const m = /translate\(([-\d.]+),?\s*([-\d.]+)\)\s*rotate\(([-\d.]+)/.exec(t);
        return {
          id: el.getAttribute('data-piece-id'),
          x: m ? Math.round(Number(m[1])) : 0,
          y: m ? Math.round(Number(m[2])) : 0,
          deg: m ? Math.round(Number(m[3]) * 100) / 100 : 0,
        };
      })
      .sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '')),
  );
const readout = async (page) => {
  const el = page.locator('[data-testid="flex-angle-readout"]');
  return (await el.count()) > 0 ? ((await el.textContent()) ?? '').trim() : null;
};
async function mmToClient(page, xMm, yMm) {
  return page.evaluate(
    ([x, y]) => {
      const s = document.querySelector('[data-testid="toy-table-canvas"]');
      const ctm = s?.getScreenCTM?.();
      if (!s || !ctm) return null;
      const pt = s.createSVGPoint();
      pt.x = x;
      pt.y = y;
      const r = pt.matrixTransform(ctm);
      return { x: r.x, y: r.y };
    },
    [xMm, yMm],
  );
}
async function clickMm(page, xMm, yMm) {
  const c = await mmToClient(page, xMm, yMm);
  if (c !== null) await page.mouse.click(c.x, c.y);
}
async function flexHold(page, fromMm, toMm) {
  const a = await mmToClient(page, fromMm[0], fromMm[1]);
  const b = await mmToClient(page, toMm[0], toMm[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.waitForTimeout(340); // engage flex
  await page.mouse.move(b.x, b.y, { steps: 6 });
}
async function saveAs(page, name) {
  await page.fill('[data-testid="save-name-input"]', name);
  await page.click('[data-testid="save-slot-button"]');
  await page.waitForTimeout(80);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 900 } },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => refute(`page error: ${e.message}`));
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="toy-table-canvas"]');
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="toy-table-canvas"]');

/* ── ATTACK 1: the flex readout must live-update and stay 2dp. ───────────────── */
await loadPieces(page, CHAIN);
await clickMm(page, 500, 300); // select B
const atRest = await readout(page);
if (atRest === null) refute('readout: no flex-angle-readout element when a piece is selected');
else if (!TWO_DP.test(atRest)) refute(`readout: at rest not 2dp: "${atRest}"`);

await flexHold(page, [500, 300], [500, 306]); // small bend
const r1 = await readout(page);
await page.mouse.move((await mmToClient(page, 500, 345)).x, (await mmToClient(page, 500, 345)).y, {
  steps: 6,
});
const r2 = await readout(page);
await page.mouse.up();
for (const [lbl, v] of [
  ['pos1', r1],
  ['pos2', r2],
]) {
  if (v === null || !TWO_DP.test(v)) refute(`readout: ${lbl} not 2dp: "${v}"`);
}
if (r1 !== null && r1 === atRest)
  refute('readout: did not live-update on the first flex move (stale)');
if (r1 !== null && r2 !== null && r1 === r2)
  refute('readout: did not track the deepening bend (pos1===pos2)');

/* ── ATTACK 2: save/load round-trip must restore pieces exactly. ─────────────── */
await page.evaluate(() => localStorage.clear());
await loadPieces(page, CHAIN);
const chainPoses = await poses(page);
await saveAs(page, 'alpha');
if ((await page.locator('[data-testid="slot-alpha"]').count()) === 0)
  refute('save: slot "alpha" did not appear');
await loadPieces(page, SINGLE);
await page.click('[data-testid="load-slot-alpha"]');
await page.waitForTimeout(120);
if (JSON.stringify(await poses(page)) !== JSON.stringify(chainPoses))
  refute('round-trip: loaded track does not match what was saved');

/* ── ATTACK 3: a name collision must OVERWRITE, never duplicate or lose data. ── */
await loadPieces(page, SINGLE);
const singlePoses = await poses(page);
await saveAs(page, 'alpha'); // same name, different track
const alphaCount = await page.locator('[data-testid="slot-alpha"]').count();
if (alphaCount !== 1) refute(`collision: expected ONE "alpha" slot, found ${alphaCount}`);
await loadPieces(page, CHAIN);
await page.click('[data-testid="load-slot-alpha"]');
await page.waitForTimeout(120);
if (JSON.stringify(await poses(page)) !== JSON.stringify(singlePoses))
  refute('collision: re-saved slot did not overwrite to the new track');

/* ── ATTACK 4: autosave must restore the track AND undo across a real reload. ── */
await page.evaluate(() => localStorage.clear());
await loadPieces(page, CHAIN);
await flexBakeMove(page); // one committed edit (a move) → undo depth 1
const beforeReload = await poses(page);
const depthBefore = await depth(page);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="toy-table-canvas"]');
await page.waitForTimeout(200);
if (JSON.stringify(await poses(page)) !== JSON.stringify(beforeReload))
  refute('autosave: track not restored after reload');
if ((await depth(page)) !== depthBefore)
  refute(`autosave: undo depth not restored after reload (${depthBefore} → ${await depth(page)})`);
await page.keyboard.press('Meta+z'); // the restored undo must work
await page.waitForTimeout(100);
if ((await depth(page)) !== depthBefore - 1)
  refute('autosave: restored undo history did not undo after reload');

/* ── ATTACK 5: corrupt localStorage must NOT wedge the editor. ───────────────── */
await page.evaluate(() => {
  localStorage.setItem('trainframe.toytable.slots', '{not json');
  localStorage.setItem('trainframe.toytable.autosave', '<<garbage');
});
await page.reload({ waitUntil: 'domcontentloaded' });
const canvasOk = (await page.locator('[data-testid="toy-table-canvas"]').count()) > 0;
if (!canvasOk) refute('corrupt storage: the editor failed to load (wedged)');
// It still functions: a fresh load + save works.
await loadPieces(page, CHAIN);
await saveAs(page, 'recovered');
if ((await page.locator('[data-testid="slot-recovered"]').count()) === 0)
  refute('corrupt storage: editor could not save after recovering');

/* ── VIDEO (criterion 7): readout live; save→build→load; autosave reload. ───── */
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="toy-table-canvas"]');
await loadPieces(page, CHAIN);
await clickMm(page, 500, 300);
await page.waitForTimeout(500);
await flexHold(page, [500, 300], [500, 350]); // readout ticks live on camera
await page.waitForTimeout(700);
await page.mouse.up();
await page.waitForTimeout(500);
await saveAs(page, 'myloop'); // save current
await page.waitForTimeout(600);
await loadPieces(page, SINGLE); // build something different
await page.waitForTimeout(700);
await page.click('[data-testid="load-slot-myloop"]'); // load it back
await page.waitForTimeout(800);
await flexBakeMove(page); // an edit, then reload to show autosave + undo
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="toy-table-canvas"]');
await page.waitForTimeout(700);
await page.keyboard.press('Meta+z'); // undo still works after reload
await page.waitForTimeout(800);

await page.close();
await ctx.close();
const video = await page.video()?.path();
await browser.close();

console.log('\n──────── SAVE/LOAD + READOUT ADVERSARIAL VERDICT ────────');
if (refutations.length === 0) {
  console.log('CANNOT-REFUTE: the readout live-updates and stays 2dp; save/load round-trips');
  console.log('exactly; a name collision overwrites without loss; autosave restores the track');
  console.log('AND undo across a reload; corrupt localStorage does not wedge the editor.');
} else {
  console.log(`REFUTED (${refutations.length}):`);
  for (const r of refutations) console.log(`  - ${r}`);
}
if (video) console.log(`video: ${video}`);
process.exit(refutations.length === 0 ? 0 : 1);

/** A committed move of piece B (one undo entry). */
async function flexBakeMove(page) {
  const from = await mmToClient(page, 500, 300);
  const to = await mmToClient(page, 700, 130);
  if (from === null || to === null) return;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}
