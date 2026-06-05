import { expect, test } from '@playwright/test';
import { nativeDragToybox, openSimulatorUi } from '../src/playwright-helpers.js';

/**
 * Proves the toybox → canvas authoring works under a *genuine* native HTML5
 * drag-and-drop (real DragEvents with a populated dataTransfer), driven via the
 * CDP drag-intercept. This is the one flow synthetic-event dispatch and
 * Playwright's mouse-based dragTo can't exercise — and the one the operator
 * actually uses. Placement is local React state, so no broker is needed.
 */
test.describe('Native drag-and-drop: toybox → canvas', () => {
  test('dragging a curve from the toybox onto the canvas places a piece', async ({ browser }) => {
    const sim = await openSimulatorUi(browser);

    await expect(sim.getByTestId('toy-table-canvas')).toBeVisible();
    await expect(sim.locator('[data-piece-id]')).toHaveCount(0);

    await nativeDragToybox(sim, 'curve');

    // The native drop fired the real toybox→canvas DnD handlers and a piece
    // landed on the table.
    await expect(sim.locator('[data-piece-id]')).toHaveCount(1);
    await expect(sim.locator('[data-piece-id^="curve-"]')).toHaveCount(1);
  });

  test('an operator can drag a placed piece to a new position', async ({ browser }) => {
    const sim = await openSimulatorUi(browser);

    // Place a straight via a toybox drag — this does NOT enter placement mode
    // (no toybox button click), so the placed piece is immediately movable. A
    // straight's bounding-box centre lies on its rail, so the grab point below
    // actually lands on the piece (a curve's bbox centre is in the arc hollow).
    await nativeDragToybox(sim, 'straight');
    const piece = sim.locator('[data-piece-id]').first();
    await expect(piece).toBeVisible();

    const before = await piece.getAttribute('transform');
    const box = await piece.boundingBox();
    if (box === null) throw new Error('piece not visible');
    const fromX = box.x + box.width / 2;
    const fromY = box.y + box.height / 2;

    // A real pointer drag (mouse.* fires genuine pointer events). The old code
    // relied on HTML5 `draggable`, which Chrome ignores on SVG, so this moved
    // nothing; pointer-based dragging follows the cursor.
    await sim.mouse.move(fromX, fromY);
    await sim.mouse.down();
    await sim.mouse.move(fromX - 160, fromY + 120, { steps: 12 });
    await sim.mouse.up();

    const after = await piece.getAttribute('transform');
    expect(after, 'piece transform should change after a pointer drag').not.toBe(before);
    // Still exactly one piece — it moved, it wasn't duplicated or dropped.
    await expect(sim.locator('[data-piece-id]')).toHaveCount(1);
  });
});
