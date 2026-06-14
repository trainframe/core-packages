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
    return {
      ok: stopped && apart && advanced,
      why: `red@${r.x | 0} blue@${bl.x | 0} spd ${r.speed | 0}/${bl.speed | 0}`,
    };
  },
  headon: (b) => {
    const h = b.find((x) => x.id === 'heavy');
    const l = b.find((x) => x.id === 'light');
    // Both wrecked to a stand, still apart; the light loco was driven BACK toward
    // its own start (recoiled) while the heavy barely shifted — momentum's winner.
    const stopped = h.speed < 5 && l.speed < 5;
    const apart = l.x - h.x > 50;
    const lightDrivenBack = l.x > 1000; // shoved back toward where it came from
    return {
      ok: stopped && apart && lightDrivenBack,
      why: `heavy@${h.x | 0} light@${l.x | 0} spd ${h.speed | 0}/${l.speed | 0}`,
    };
  },
  push: (b) => {
    const r = b.find((x) => x.id === 'red');
    const w = b.find((x) => x.id === 'wagon');
    return {
      // After the loco halts the wagon rolls ON, carrying momentum: it pulls clear
      // (gap well past contact) and comes to rest under rolling friction, uncoupled.
      ok: w.x > 700 && w.x - r.x > 90 && w.coupledTo.length === 0 && w.speed < 5 && r.speed < 5,
      why: `wagon@${w.x | 0} gap ${(w.x - r.x) | 0} wspd ${w.speed | 0} coupled ${w.coupledTo.length}`,
    };
  },
  terminus: (b) => {
    const r = b.find((x) => x.id === 'red');
    return {
      ok: r.fate === 'on-rail' && r.mode === 'railed' && r.speed < 5,
      why: `fate ${r.fate} @${r.x | 0} spd ${r.speed | 0}`,
    };
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
    return {
      ok: err < 40,
      why: `measured ${Math.round(vision.reportedMm)}mm vs expected ${Math.round(vision.expectedMm)}mm (err ${Math.round(err)})`,
    };
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
    return {
      ok: up < flat - 5 && flat < down - 5,
      why: `up ${up | 0} < flat ${flat | 0} < down ${down | 0}`,
    };
  },
  'crane-drop': (b) => {
    const t = b.find((x) => x.id === 'T');
    const crate = b.find((x) => x.id === 'crate');
    // The crane set the crate down on the line and the train wrecked on it.
    return {
      ok: !!crate && t?.fate === 'derailed' && crate.fate === 'derailed',
      why: `train ${t?.fate} crate ${crate ? crate.fate : 'absent'}`,
    };
  },
  turntable: (b) => {
    // The loco boarded heading east (rotation 0), the deck physically carried it
    // round a half-turn, and it must leave via the WESTBOUND turn-around stub
    // FACING THE OTHER WAY (rotation 180) — the honest 180° turn, pose-continuous.
    const l = b.find((x) => x.id === 'L');
    const ok = !!l && l.segment === 'seg-stub-w' && Math.round(l.rotationDeg) === 180;
    return { ok, why: `L@${l ? l.segment : 'absent'} rot ${l ? Math.round(l.rotationDeg) : '?'}` };
  },
  depot: (b) => {
    // ADR-032 nested zone: the depot turned each visiting loco on its interior
    // turntable and routed it onto a stall. Both locos must end PARKED on DISTINCT
    // stall parking tracks (`track-N`) — routed correctly, the turntable serving
    // one at a time. (The stalls are `track-0..3`; A→track-0, B→track-2.)
    const segA = b.find((x) => x.id === 'A')?.segment;
    const segB = b.find((x) => x.id === 'B')?.segment;
    const onStall = (s) => typeof s === 'string' && s.startsWith('track-');
    const ok = onStall(segA) && onStall(segB) && segA !== segB;
    return { ok, why: `A@${segA ?? 'absent'} B@${segB ?? 'absent'}` };
  },
  'lift-bridge': (b) => {
    // The span started RAISED (rail broken). The train must have HELD short of
    // the gap (never running off), then crossed once the span lowered — so it ends
    // ACROSS, on the far approach, on-rail.
    const t = b.find((x) => x.id === 'T');
    const ok = !!t && t.fate === 'on-rail' && t.mode === 'railed' && t.segment === 'far';
    return { ok, why: `T@${t ? t.segment : 'absent'} fate ${t ? t.fate : '?'}` };
  },
  'bridge-runoff': (b) => {
    // The CONTRAST to lift-bridge: NO controller holds the train. The span stayed
    // RAISED (rail broken) and the train drove straight at the open gap — so it
    // must have RUN OFF (fate `ran-off`), not been held short.
    const t = b.find((x) => x.id === 'T');
    return { ok: t?.fate === 'ran-off', why: `T fate ${t ? t.fate : 'absent'}` };
  },
  'railyard-demo': (b) => {
    // Multi-loop layout + serialised yard. Flood-fill each serviced loco's rake;
    // assert the train→train swap (LA picked up the gold spare cut g0; LB picked
    // up a former-A car), that everything stayed railed (no collision/derail), and
    // that nothing floats (every body railed). The view tallies services in the
    // title; we read body state from the world handle.
    const rake = (loco) => {
      const seen = new Set([loco]);
      const stack = [loco];
      while (stack.length) {
        const c = stack.pop();
        for (const n of b.find((x) => x.id === c)?.coupledTo ?? [])
          if (!seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
      }
      return seen;
    };
    const laRake = rake('LA');
    const lbRake = rake('LB');
    const allRailed = b.every((x) => x.mode === 'railed');
    const noWreck = b.every((x) => x.fate === 'on-rail');
    const gotGold = laRake.has('g0');
    const migrated = ['LAc0', 'LAc1', 'LAc2'].some((c) => lbRake.has(c));
    return {
      ok: allRailed && noWreck && gotGold && migrated,
      why: `LA={${[...laRake].sort().join(',')}} LB={${[...lbRake].sort().join(',')}} railed=${allRailed} onRail=${noWreck}`,
    };
  },
  railyard: (b) => {
    const coupled = (id) => b.find((x) => x.id === id)?.coupledTo ?? [];
    const seg = (id) => b.find((x) => x.id === id)?.segment;
    // Flood-fill the departing loco's rake over its couplings.
    const seen = new Set(['L']);
    const stack = ['L'];
    while (stack.length) {
      const c = stack.pop();
      for (const n of coupled(c))
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
    }
    const ok =
      seen.has('p0') &&
      !seen.has('a2') &&
      seg('a2') === 'slot0' &&
      ['leadE', 'eleg1'].includes(seg('L'));
    return { ok, why: `rake={${[...seen].sort().join(',')}} a2@${seg('a2')} L@${seg('L')}` };
  },
};

const DURATION = {
  collision: 7,
  headon: 7,
  push: 8,
  terminus: 7,
  couple: 7,
  tugofwar: 6,
  derail: 6,
  runoff: 6,
  vision: 9,
  load: 7,
  ramps: 7,
  railyard: 42,
  /* Five trains across two loops + three full yard services (svc at ~47/96/144 s),
   *  the main-loop trains held on block clearance between — budget past the third. */
  'railyard-demo': 165,
  turntable: 30,
  /* Two full board→turn→park cycles, the deck swinging slowly and serialised —
   *  budget generously. */
  depot: 60,
  'crane-drop': 12,
  'lift-bridge': 14,
  'bridge-runoff': 8,
};

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
    : [
        'collision',
        'headon',
        'push',
        'terminus',
        'couple',
        'tugofwar',
        'derail',
        'runoff',
        'vision',
        'load',
        'ramps',
      ];
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
