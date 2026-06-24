import { expect, test } from '@playwright/test';
import { dragPieceFromToybox, openSimulatorUi, placePieceOnToyTable } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Criterion 6 recordings: capture both demos on the real toy table so a SECOND
 * adversary can review them frame-by-frame —
 *   A) a flexed line surviving an ADDED piece (no vanish), and
 *   B) a piece dragged from the parts menu, rotated + flipped in flight, dropped.
 * Each runs in its own recorded context; the video finalises on context close.
 */

const VIDEO_DIR = new URL('../videos/feature-b/', import.meta.url).pathname;

interface Pose {
  id: string;
  x: number;
  y: number;
  deg: number;
}

test.describe.serial('feature recordings', () => {
  test.describe.configure({ retries: 2 });
  let harness: UiHarness;
  test.beforeAll(async () => {
    harness = await startUiHarness({ discovery: true, wsPort: 9134 });
  });
  test.afterAll(async () => {
    await harness.shutdown();
  });

  test('A: flex a chain then add a piece — nothing vanishes (recorded)', async ({ browser }) => {
    test.setTimeout(120_000);
    const sim = await openSimulatorUi(browser, {
      brokerUrl: harness.brokerWsUrl,
      recordVideoDir: VIDEO_DIR,
    });
    const canvas = sim.getByTestId('toy-table-canvas');
    await canvas.waitFor({ state: 'visible' });
    await sim.waitForTimeout(500);

    const rect = await canvas.boundingBox();
    if (rect === null) throw new Error('no canvas');
    const zoom = Number(await canvas.getAttribute('data-viewport-zoom')) || 1;
    const worldW = 900 / zoom;
    const worldH = worldW * (rect.height / rect.width);
    const rowY = worldH * 0.42;

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await placePieceOnToyTable(sim, { type: 'straight', xMm: worldW * 0.14 + i * 200, yMm: rowY }));
    }
    // Disarm, then flex the free end with a real press-hold-drag.
    const armed = sim.locator('[data-testid^="toybox-"][aria-pressed="true"]');
    if ((await armed.count()) > 0) await armed.first().click();

    const endBox = await sim.locator(`[data-piece-id="${ids[2]}"]`).boundingBox();
    if (endBox === null) throw new Error('end piece gone');
    const cx = endBox.x + endBox.width / 2;
    const cy = endBox.y + endBox.height / 2;
    await sim.mouse.move(cx, cy);
    await sim.mouse.down();
    await sim.waitForTimeout(350);
    for (let i = 1; i <= 12; i++) await sim.mouse.move(cx, cy + (60 * i) / 12);
    await sim.mouse.up();
    await sim.waitForTimeout(400);

    // Add a piece onto the flexed end; assert all four pieces remain.
    await placePieceOnToyTable(sim, { type: 'straight', xMm: worldW * 0.7, yMm: rowY });
    await sim.waitForTimeout(600);
    const poses: Pose[] = await sim.locator('[data-piece-id]').evaluateAll((els) =>
      els.map((el) => {
        const t = el.getAttribute('transform') ?? '';
        const tr = /translate\(([-\d.eE]+),?\s*([-\d.eE]+)\)/.exec(t);
        return {
          id: el.getAttribute('data-piece-id') ?? '',
          x: tr ? Number.parseFloat(tr[1] ?? 'NaN') : Number.NaN,
          y: tr ? Number.parseFloat(tr[2] ?? 'NaN') : Number.NaN,
          deg: 0,
        };
      }),
    );
    expect(poses.length, 'four pieces present after flex+add').toBe(4);
    for (const p of poses) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    await sim.waitForTimeout(800);
    await sim.context().close();
  });

  test('B: drag a curve from the menu, rotate + flip in flight, drop (recorded)', async ({ browser }) => {
    test.setTimeout(120_000);
    const sim = await openSimulatorUi(browser, {
      brokerUrl: harness.brokerWsUrl,
      recordVideoDir: VIDEO_DIR,
    });
    await sim.getByTestId('toy-table-canvas').waitFor({ state: 'visible' });
    await sim.waitForTimeout(500);

    await dragPieceFromToybox(sim, 'curve', { targetPosition: { x: 300, y: 90 }, orient: ['r', 'r', 'f'] });
    await sim.waitForTimeout(400);
    const transform = await sim.locator('[data-piece-id^="curve-"]').first().getAttribute('transform');
    expect(transform).toMatch(/rotate\(90/);
    expect(transform).toMatch(/scale\(1,\s*-1\)/);

    // A second drag of a different type, no orientation, to show the plain path.
    await dragPieceFromToybox(sim, 'straight', { targetPosition: { x: 500, y: 90 } });
    await sim.waitForTimeout(800);
    await sim.context().close();
  });
});
