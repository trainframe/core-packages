import { type Page, expect, test } from '@playwright/test';
import { openSimulatorUi, placePieceOnToyTable } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * LIVE reproduction / guard (goal A, criterion 1): on the REAL toy table in a
 * real browser (real RAF, real setPointerCapture, real recompile), build a
 * CONNECTED chain (the canvas-click path snaps via computePlacement), flex it
 * with a real press-hold-drag gesture, then add a new piece — asserting NO piece
 * vanishes (missing / non-finite / off-canvas) and that EACH flex genuinely bent
 * the chain (non-vacuous), so a pass is a real exoneration of the flex→add path.
 *
 * Drives the END piece and the ANCHOR-side piece across several flex+add rounds.
 * The deterministic geometry sweep (packages/simulator flex-add-vanish.property)
 * covers curves / tight curves / flips exhaustively; this spec adds the
 * real-browser timing dimension.
 */

interface Pose {
  id: string;
  x: number;
  y: number;
  deg: number;
}

async function readPoses(sim: Page): Promise<Pose[]> {
  return sim.locator('[data-piece-id]').evaluateAll((els) =>
    els.map((el) => {
      const t = el.getAttribute('transform') ?? '';
      const tr = /translate\(([-\d.eE]+),?\s*([-\d.eE]+)\)/.exec(t);
      const ro = /rotate\(([-\d.eE]+)/.exec(t);
      return {
        id: el.getAttribute('data-piece-id') ?? '',
        x: tr ? Number.parseFloat(tr[1] ?? 'NaN') : Number.NaN,
        y: tr ? Number.parseFloat(tr[2] ?? 'NaN') : Number.NaN,
        deg: ro ? Number.parseFloat(ro[1] ?? 'NaN') : Number.NaN,
      };
    }),
  );
}

async function poseOf(sim: Page, id: string): Promise<Pose> {
  const p = (await readPoses(sim)).find((q) => q.id === id);
  if (p === undefined) throw new Error(`piece ${id} not found`);
  return p;
}

interface Viewport {
  vpX: number;
  vpY: number;
  worldW: number;
  worldH: number;
  rect: { x: number; y: number; width: number; height: number };
}

/** Read the visible world window (mm). The toy-table canvas is WIDE and SHORT,
   so worldH (≈168mm at 1280×720) is much smaller than worldW — placements MUST
   stay inside this band or clicks clamp off-canvas. */
async function viewport(sim: Page): Promise<Viewport> {
  const canvas = sim.getByTestId('toy-table-canvas');
  const rect = await canvas.boundingBox();
  if (rect === null) throw new Error('no canvas rect');
  const zoom = Number(await canvas.getAttribute('data-viewport-zoom')) || 1;
  const vpX = Number(await canvas.getAttribute('data-viewport-x')) || 0;
  const vpY = Number(await canvas.getAttribute('data-viewport-y')) || 0;
  const worldW = 900 / zoom;
  const worldH = worldW * (rect.height / rect.width);
  return { vpX, vpY, worldW, worldH, rect };
}

/** Convert world-mm to absolute client px (inverse of ToyTable.clientToMm). */
async function mmToClientPx(
  sim: Page,
  xMm: number,
  yMm: number,
): Promise<{ x: number; y: number }> {
  const v = await viewport(sim);
  return {
    x: v.rect.x + ((xMm - v.vpX) / v.worldW) * v.rect.width,
    y: v.rect.y + ((yMm - v.vpY) / v.worldH) * v.rect.height,
  };
}

/** Disarm any armed toybox piece so the next pointerdown flexes, not places. */
async function disarm(sim: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const pressed = await sim.locator('[data-testid^="toybox-"][aria-pressed="true"]').count();
    if (pressed === 0) return;
    await sim.locator('[data-testid^="toybox-"][aria-pressed="true"]').first().click();
    await sim.waitForTimeout(120);
  }
  throw new Error('could not disarm toybox');
}

/** Real flex gesture grabbing the piece's mm ORIGIN: press, hold past the 250ms
   dwell (still), drag, release. Returns how far the grabbed piece moved (px+deg)
   so the caller can assert the gesture was not vacuous. */
async function flexPieceAtOrigin(
  sim: Page,
  id: string,
  dxMm: number,
  dyMm: number,
): Promise<number> {
  const start = await poseOf(sim, id);
  const c = await mmToClientPx(sim, start.x, start.y);
  const target = await mmToClientPx(sim, start.x + dxMm, start.y + dyMm);
  await sim.mouse.move(c.x, c.y);
  await sim.mouse.down();
  await sim.waitForTimeout(330); // past FLEX_HOLD_MS (250), inside the deadzone
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await sim.mouse.move(
      c.x + ((target.x - c.x) * i) / steps,
      c.y + ((target.y - c.y) * i) / steps,
    );
    await sim.waitForTimeout(18);
  }
  await sim.mouse.up();
  await sim.waitForTimeout(80);
  const end = await poseOf(sim, id);
  return Math.hypot(end.x - start.x, end.y - start.y) + Math.abs(end.deg - start.deg);
}

function assertNoVanish(poses: Pose[], expectedIds: ReadonlySet<string>, where: string): void {
  const ids = new Set(poses.map((p) => p.id));
  const missing = [...expectedIds].filter((w) => !ids.has(w));
  expect(
    missing,
    `${where}: missing pieces ${JSON.stringify(missing)} (have ${JSON.stringify([...ids])})`,
  ).toEqual([]);
  for (const p of poses) {
    expect(
      Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.deg),
      `${where}: ${p.id} finite (${p.x},${p.y},${p.deg})`,
    ).toBe(true);
    expect(p.x > -900 && p.x < 1900, `${where}: ${p.id} x on-canvas (${p.x})`).toBe(true);
    expect(p.y > -900 && p.y < 1500, `${where}: ${p.id} y on-canvas (${p.y})`).toBe(true);
  }
}

async function screenshotIfLost(
  sim: Page,
  present: ReadonlySet<string>,
  label: string,
): Promise<void> {
  const ids = new Set((await readPoses(sim)).map((p) => p.id));
  if ([...present].some((w) => !ids.has(w))) {
    await sim.screenshot({ path: `test-results/vanish-${label}.png` });
  }
}

test.describe
  .serial('LIVE: flex then add never vanishes a piece', () => {
    test.describe.configure({ retries: 2 }); // preview-build click placement is mildly flaky
    let harness: UiHarness;
    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9133 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('straight chain: build → flex (end + anchor, real bend) → add (x3) keeps every piece', async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      const errors: string[] = [];
      sim.on('pageerror', (e) => errors.push(String(e)));
      sim.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      const canvas = sim.getByTestId('toy-table-canvas');
      await canvas.waitFor({ state: 'visible' });
      await sim.waitForTimeout(600); // let the app settle (avoid a hydration/click race)

      // Place all pieces inside the visible world band (wide + short canvas) so no
      // click clamps off-canvas. Build a connected straight chain (140mm apart →
      // each click snaps onto the previous open end): anchor end, middle, free end.
      const v = await viewport(sim);
      const baseX = v.vpX + v.worldW * 0.14;
      const rowY = v.vpY + v.worldH * 0.42;
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(
          await placePieceOnToyTable(sim, { type: 'straight', xMm: baseX + i * 200, yMm: rowY }),
        );
      }
      await disarm(sim);
      const present = new Set(ids);
      assertNoVanish(await readPoses(sim), present, 'after build');
      await sim.screenshot({ path: 'test-results/vanish-00-built.png' });

      const dyMm = v.worldH * 0.3; // a flex drag that stays inside the visible band

      for (let round = 0; round < 2; round++) {
        // Round 0: flex the free END; round 1: flex the ANCHOR-side piece. Both
        // exercise a real bend of the connected chain before adding a piece.
        await disarm(sim);
        const flexId = round === 1 ? (ids[0] as string) : (ids[ids.length - 1] as string);
        const moved = await flexPieceAtOrigin(sim, flexId, 0, round % 2 === 0 ? dyMm : -dyMm);
        const afterFlex = await readPoses(sim);
        await sim.screenshot({ path: `test-results/vanish-r${round}-1flexed.png` });
        // eslint-disable-next-line no-console
        console.log(
          `r${round} flex ${flexId}: moved=${moved.toFixed(1)} count=${afterFlex.length}`,
        );
        // The flex MUST have bent the chain — else this round is a vacuous test.
        expect(moved, `round ${round}: flex of ${flexId} actually moved the chain`).toBeGreaterThan(
          4,
        );
        await screenshotIfLost(sim, present, `r${round}-flex`);
        assertNoVanish(afterFlex, present, `round ${round} after flex ${flexId}`);

        // Add a new straight just past the free end (kept inside the band) so it snaps on.
        const end = await poseOf(sim, ids[ids.length - 1] as string);
        const addX = Math.min(end.x + 150, v.vpX + v.worldW * 0.92);
        ids.push(await placePieceOnToyTable(sim, { type: 'straight', xMm: addX, yMm: end.y }));
        present.add(ids[ids.length - 1] as string);
        await sim.screenshot({ path: `test-results/vanish-r${round}-2added.png` });
        await screenshotIfLost(sim, present, `r${round}-add`);
        assertNoVanish(await readPoses(sim), present, `round ${round} after add`);
      }

      expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
      await sim.context().close();
    });
  });
