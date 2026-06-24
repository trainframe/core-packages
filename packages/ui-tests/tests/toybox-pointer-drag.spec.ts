import { expect, test } from '@playwright/test';
import { dragPieceFromToybox, openSimulatorUi } from '../src/playwright-helpers.js';

/**
 * Feature B (criteria 4 & 6) on the REAL stack: dragging a piece from the parts
 * menu carries the REAL piece onto the table — no native HTML5 drag-image ghost
 * — and R/F orient it in flight before it commits. Placement is local React
 * state, so no broker is needed.
 */
test.describe('Parts-menu pointer drag: toybox → canvas', () => {
  test('the toybox tiles are NOT native-draggable (no static drag-image ghost)', async ({
    browser,
  }) => {
    const sim = await openSimulatorUi(browser);
    await expect(sim.getByTestId('toy-table-canvas')).toBeVisible();
    // Feature B replaced native HTML5 DnD with a controlled pointer drag.
    await expect(sim.getByTestId('toybox-curve')).not.toHaveAttribute('draggable', 'true');
  });

  test('dragging a curve from the menu places the real piece on the table', async ({ browser }) => {
    const sim = await openSimulatorUi(browser);
    await expect(sim.getByTestId('toy-table-canvas')).toBeVisible();
    await expect(sim.locator('[data-piece-id]')).toHaveCount(0);

    await dragPieceFromToybox(sim, 'curve', { targetPosition: { x: 300, y: 90 } });

    await expect(sim.locator('[data-piece-id]')).toHaveCount(1);
    await expect(sim.locator('[data-piece-id^="curve-"]')).toHaveCount(1);
  });

  test('R/F orient the piece DURING the drag; the committed orientation matches', async ({
    browser,
  }) => {
    const sim = await openSimulatorUi(browser);
    await expect(sim.getByTestId('toy-table-canvas')).toBeVisible();

    // Drop in open space (no neighbour to snap to) so the chosen orientation is
    // what commits. Two R presses ⇒ 90°, one F ⇒ flipped (scale(1,-1)).
    await dragPieceFromToybox(sim, 'curve', {
      targetPosition: { x: 300, y: 90 },
      orient: ['r', 'r', 'f'],
    });

    const piece = sim.locator('[data-piece-id^="curve-"]').first();
    await expect(piece).toBeVisible();
    const transform = await piece.getAttribute('transform');
    expect(transform, 'committed rotation matches the in-flight R presses').toMatch(/rotate\(90/);
    expect(transform, 'committed flip matches the in-flight F press').toMatch(/scale\(1,\s*-1\)/);
    await expect(sim.locator('[data-piece-id]')).toHaveCount(1);
  });

  test('an operator can drag a placed piece to a new position', async ({ browser }) => {
    const sim = await openSimulatorUi(browser);

    // Place a straight via a parts-menu drag (no arming), then move it. A
    // straight's bbox centre lies on its rail, so the grab point lands on it.
    await dragPieceFromToybox(sim, 'straight', { targetPosition: { x: 300, y: 90 } });
    const piece = sim.locator('[data-piece-id]').first();
    await expect(piece).toBeVisible();

    const before = await piece.getAttribute('transform');
    const box = await piece.boundingBox();
    if (box === null) throw new Error('piece not visible');
    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height / 2;

    await sim.mouse.move(fromX, fromY);
    await sim.mouse.down();
    await sim.mouse.move(fromX + 140, fromY + 60, { steps: 12 });
    await sim.mouse.up();

    const after = await piece.getAttribute('transform');
    expect(after, 'piece transform should change after a pointer drag').not.toBe(before);
    await expect(sim.locator('[data-piece-id]')).toHaveCount(1);
  });
});
