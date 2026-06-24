import { type Page, expect, test } from '@playwright/test';
import {
  dragPieceFromToybox,
  openSimulatorUi,
  placePieceOnToyTable,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * The user's ACTUAL current workflow (goal A, criterion 1): build a chain, FLEX
 * it, then ADD a new piece via FEATURE B (the new pointer-drag) onto the flexed,
 * baked, off-grid end — a code path (Feature B's move-snap commit against a baked
 * neighbour) that has never run crossed with flex. Hunt for the reported vanish:
 * after each flex and each drag-add, assert no piece is missing / non-finite /
 * flung outside the VISIBLE canvas band.
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

interface View {
  vpX: number;
  vpY: number;
  worldW: number;
  worldH: number;
  rect: { x: number; y: number; width: number; height: number };
}
async function view(sim: Page): Promise<View> {
  const canvas = sim.getByTestId('toy-table-canvas');
  const rect = await canvas.boundingBox();
  if (rect === null) throw new Error('no canvas rect');
  const zoom = Number(await canvas.getAttribute('data-viewport-zoom')) || 1;
  const vpX = Number(await canvas.getAttribute('data-viewport-x')) || 0;
  const vpY = Number(await canvas.getAttribute('data-viewport-y')) || 0;
  const worldW = 900 / zoom;
  return { vpX, vpY, worldW, worldH: worldW * (rect.height / rect.width), rect };
}
async function mmToPx(sim: Page, xMm: number, yMm: number): Promise<{ x: number; y: number }> {
  const v = await view(sim);
  return {
    x: v.rect.x + ((xMm - v.vpX) / v.worldW) * v.rect.width,
    y: v.rect.y + ((yMm - v.vpY) / v.worldH) * v.rect.height,
  };
}

async function disarm(sim: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const armed = sim.locator('[data-testid^="toybox-"][aria-pressed="true"]');
    if ((await armed.count()) === 0) return;
    await armed.first().click();
    await sim.waitForTimeout(120);
  }
}

/** Real flex gesture grabbing the piece's mm origin; returns how far it moved. */
async function flex(sim: Page, id: string, dxMm: number, dyMm: number): Promise<number> {
  const start = await poseOf(sim, id);
  const c = await mmToPx(sim, start.x, start.y);
  const target = await mmToPx(sim, start.x + dxMm, start.y + dyMm);
  await sim.mouse.move(c.x, c.y);
  await sim.mouse.down();
  await sim.waitForTimeout(330);
  for (let i = 1; i <= 12; i++) {
    await sim.mouse.move(c.x + ((target.x - c.x) * i) / 12, c.y + ((target.y - c.y) * i) / 12);
    await sim.waitForTimeout(18);
  }
  await sim.mouse.up();
  await sim.waitForTimeout(80);
  const end = await poseOf(sim, id);
  return Math.hypot(end.x - start.x, end.y - start.y) + Math.abs(end.deg - start.deg);
}

function assertNoVanish(poses: Pose[], present: ReadonlySet<string>, where: string): void {
  const ids = new Set(poses.map((p) => p.id));
  const missing = [...present].filter((w) => !ids.has(w));
  expect(
    missing,
    `${where}: missing ${JSON.stringify(missing)} (have ${JSON.stringify([...ids])})`,
  ).toEqual([]);
  for (const p of poses) {
    expect(
      Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.deg),
      `${where}: ${p.id} finite (${p.x},${p.y},${p.deg})`,
    ).toBe(true);
    // Tight bound: a piece flung off the (generous) visible region is a "vanish".
    expect(p.x > -1500 && p.x < 2400, `${where}: ${p.id} x (${p.x})`).toBe(true);
    expect(p.y > -1500 && p.y < 1800, `${where}: ${p.id} y (${p.y})`).toBe(true);
  }
}

test.describe
  .serial('flex then Feature-B drag-add never vanishes a piece', () => {
    test.describe.configure({ retries: 2 });
    let harness: UiHarness;
    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9135 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('build → flex (end + anchor) → DRAG-ADD via Feature B onto the flexed end (x2)', async ({
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
      await sim.waitForTimeout(600);

      const v = await view(sim);
      const baseX = v.vpX + v.worldW * 0.14;
      const rowY = v.vpY + v.worldH * 0.42;
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        ids.push(
          await placePieceOnToyTable(sim, { type: 'straight', xMm: baseX + i * 200, yMm: rowY }),
        );
      }
      await disarm(sim);
      const present = new Set(ids);
      assertNoVanish(await readPoses(sim), present, 'after build');

      const dy = v.worldH * 0.3;
      for (let round = 0; round < 2; round++) {
        await disarm(sim);
        const flexId = round === 1 ? (ids[0] as string) : (ids[ids.length - 1] as string);
        const moved = await flex(sim, flexId, 0, round % 2 === 0 ? dy : -dy);
        // eslint-disable-next-line no-console
        console.log(
          `r${round} flex ${flexId}: moved=${moved.toFixed(1)} count=${(await readPoses(sim)).length}`,
        );
        expect(moved, `round ${round}: flex moved the chain`).toBeGreaterThan(4);
        assertNoVanish(await readPoses(sim), present, `round ${round} after flex`);

        // DRAG-ADD via Feature B onto the flexed end's vicinity (px target inside
        // the visible band, near the flexed free end).
        const end = await poseOf(sim, ids[ids.length - 1] as string);
        const endPx = await mmToPx(sim, Math.min(end.x + 120, v.vpX + v.worldW * 0.9), end.y);
        const cBox = await canvas.boundingBox();
        if (cBox === null) throw new Error('no canvas');
        const before = new Set((await readPoses(sim)).map((p) => p.id));
        await dragPieceFromToybox(sim, 'straight', {
          targetPosition: { x: endPx.x - cBox.x, y: endPx.y - cBox.y },
        });
        await sim.waitForTimeout(400);
        const added = (await readPoses(sim)).map((p) => p.id).find((id) => !before.has(id));
        if (added === undefined) throw new Error(`round ${round}: drag-add produced no piece`);
        ids.push(added);
        present.add(added);
        // eslint-disable-next-line no-console
        console.log(`r${round} drag-added ${added}; count=${(await readPoses(sim)).length}`);
        assertNoVanish(await readPoses(sim), present, `round ${round} after drag-add`);
      }

      expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
      await sim.context().close();
    });
  });
