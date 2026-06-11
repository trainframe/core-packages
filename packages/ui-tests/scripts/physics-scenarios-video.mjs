// @ts-check
/**
 * Record the seven ADR-030 physics acceptance scenarios and assert each one's
 * outcome from the authoritative world (`window.__tfPhysics`). Each scenario is
 * a standalone page (`?physics=<name>`) that auto-runs — no broker, no core.
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/physics-scenarios-video.mjs
 *
 * Prereq: the sim-ui dev server on :5274. Videos → videos/physics/<name>.webm,
 * stills → videos/physics/<name>-{start,mid,end}.png.
 */
import { mkdirSync, renameSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.TF_URL ?? 'http://localhost:5274/';
const OUT = new URL('../videos/physics/', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[phys] ${m}\n`);

/** name → (bodies, durationS) → {ok, why}. */
const CHECKS = {
  collision: (b) => {
    const r = b.find((x) => x.id === 'red');
    const bl = b.find((x) => x.id === 'blue');
    const stopped = r.speed < 5 && bl.speed < 5;
    const apart = bl.x - r.x > 40 && bl.x - r.x < 100;
    const advanced = r.x > 300 && bl.x < 1500;
    return { ok: stopped && apart && advanced, why: `red@${r.x | 0} blue@${bl.x | 0} spd ${r.speed | 0}/${bl.speed | 0}` };
  },
  push: (b) => {
    const r = b.find((x) => x.id === 'red');
    const w = b.find((x) => x.id === 'wagon');
    return {
      ok: w.x > 700 && w.x - r.x > 40 && w.x - r.x < 80 && w.coupledTo.length === 0,
      why: `wagon@${w.x | 0} gap ${(w.x - r.x) | 0} coupled ${w.coupledTo.length}`,
    };
  },
  terminus: (b) => {
    const r = b.find((x) => x.id === 'red');
    return { ok: r.fate === 'on-rail' && r.mode === 'railed' && r.speed < 5, why: `fate ${r.fate} @${r.x | 0} spd ${r.speed | 0}` };
  },
  couple: (b) => {
    const r = b.find((x) => x.id === 'red');
    return { ok: r.coupledTo.includes('wagon'), why: `coupled ${JSON.stringify(r.coupledTo)}` };
  },
  tugofwar: (b) => {
    const w = b.find((x) => x.id === 'wagon');
    // started at railPos 1000 → world x ~ (computed); assert it barely moved.
    return { ok: w.speed < 5, why: `wagon spd ${w.speed | 0} @${w.x | 0}` };
  },
  derail: (b) => {
    const r = b.find((x) => x.id === 'red');
    return { ok: r.fate === 'derailed', why: `fate ${r.fate}` };
  },
  runoff: (b) => {
    const r = b.find((x) => x.id === 'red');
    return { ok: r.fate === 'ran-off', why: `fate ${r.fate}` };
  },
  vision: (_b, vision) => {
    if (!vision || vision.reportedMm == null) return { ok: false, why: 'no length reported' };
    const err = Math.abs(vision.reportedMm - vision.expectedMm);
    return { ok: err < 40, why: `measured ${Math.round(vision.reportedMm)}mm vs expected ${Math.round(vision.expectedMm)}mm (err ${Math.round(err)})` };
  },
  load: (b) => {
    // L0..L4 pull 1..5 carriages; fewer carriages → travels further.
    const xs = [0, 1, 2, 3, 4].map((i) => b.find((x) => x.id === `L${i}`)?.x ?? Number.NaN);
    const strictlyDescending = xs.every((x, i) => i === 0 || xs[i - 1] > x + 5);
    return { ok: strictlyDescending, why: `x: ${xs.map((x) => Math.round(x)).join(' > ')}` };
  },
  ramps: (b) => {
    const sp = (id) => b.find((x) => x.id === id)?.speed ?? Number.NaN;
    const up = sp('up');
    const flat = sp('flat');
    const down = sp('down');
    return { ok: up < flat - 5 && flat < down - 5, why: `up ${up | 0} < flat ${flat | 0} < down ${down | 0}` };
  },
  railyard: (b) => {
    const coupled = (id) => b.find((x) => x.id === id)?.coupledTo ?? [];
    const seg = (id) => b.find((x) => x.id === id)?.segment;
    // Flood-fill the departing loco's rake over its couplings.
    const seen = new Set(['L']);
    const stack = ['L'];
    while (stack.length) {
      const c = stack.pop();
      for (const n of coupled(c)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    }
    const ok =
      seen.has('p0') && !seen.has('a2') && seg('a2') === 'slot0' && ['leadE', 'eleg1'].includes(seg('L'));
    return { ok, why: `rake={${[...seen].sort().join(',')}} a2@${seg('a2')} L@${seg('L')}` };
  },
};

const DURATION = { collision: 7, push: 5, terminus: 7, couple: 7, tugofwar: 6, derail: 6, runoff: 6, vision: 9, load: 7, ramps: 7, railyard: 42 };

async function runScenario(browser, name) {
  const durS = DURATION[name] ?? 7;
  const context = await browser.newContext({
    viewport: { width: 1100, height: 620 },
    recordVideo: { dir: OUT, size: { width: 1100, height: 620 } },
  });
  const page = await context.newPage();
  await page.goto(`${BASE}?physics=${name}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="physics-canvas"]', { timeout: 10000 });
  await page.waitForFunction(() => !!window.__tfPhysics, undefined, { timeout: 10000 });

  await sleep(300);
  await page.screenshot({ path: `${OUT}${name}-start.png` });
  await sleep((durS / 2) * 1000);
  await page.screenshot({ path: `${OUT}${name}-mid.png` });
  await sleep((durS / 2) * 1000);
  const bodies = await page.evaluate(() => window.__tfPhysics?.bodies() ?? []);
  const vision = await page.evaluate(() => window.__tfVision ?? null);
  await page.screenshot({ path: `${OUT}${name}-end.png` });

  const check = CHECKS[name];
  const result = check ? check(bodies, vision) : { ok: false, why: 'no check' };
  log(`${result.ok ? 'PASS' : 'FAIL'} ${name} — ${result.why}`);

  const video = page.video();
  await context.close();
  if (video) {
    const src = await video.path();
    renameSync(src, `${OUT}${name}.webm`);
  }
  return { name, ...result };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const names = process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['collision', 'push', 'terminus', 'couple', 'tugofwar', 'derail', 'runoff', 'vision', 'load', 'ramps'];
  const browser = await chromium.launch();
  const results = [];
  for (const name of names) results.push(await runScenario(browser, name));
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  log(`=== ${passed}/${results.length} scenarios passed ===`);
  for (const r of results) if (!r.ok) log(`  FAIL ${r.name}: ${r.why}`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
