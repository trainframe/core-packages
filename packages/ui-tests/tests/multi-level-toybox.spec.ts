import { expect, test } from '@playwright/test';
import { openSimulatorUi, placePieceOnToyTable } from '../src/playwright-helpers.js';

/**
 * The toybox is no longer capped at two decks. An operator can grow the deck
 * selector with "+ Add level", author track on an arbitrary level, and see it
 * stand on support piers — except where it bridges over the track beneath, where
 * the pier is omitted so a column never lands on the lower rail.
 *
 * Placement is local React state, so no broker is needed.
 */
test.describe('Multi-level toybox', () => {
  test('an operator can add levels beyond Ground/Upper and author on Level 2', async ({
    browser,
  }) => {
    const sim = await openSimulatorUi(browser);
    await expect(sim.getByTestId('toy-table-canvas')).toBeVisible();

    // Only Ground exists at first; there is no Level 2 yet.
    await expect(sim.getByTestId('active-layer-0')).toBeVisible();
    await expect(sim.getByTestId('active-layer-2')).toHaveCount(0);

    // Grow the stack two decks up. Each press adds the next level and makes it
    // active, so the selector now offers Ground, Level 1, Level 2.
    await sim.getByTestId('add-level').click();
    await sim.getByTestId('add-level').click();
    await expect(sim.getByTestId('active-layer-1')).toBeVisible();
    await expect(sim.getByTestId('active-layer-2')).toBeVisible();
    await expect(sim.getByTestId('active-layer-2')).toHaveAttribute('aria-pressed', 'true');

    // Author a piece — it lands on the active deck (Level 2).
    const pieceId = await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });

    // It renders inside the Level-2 layer group...
    const deck2 = sim.locator('g[data-layer="2"]');
    await expect(deck2.locator(`[data-piece-id="${pieceId}"]`)).toHaveCount(1);

    // ...and, being raised over open table, it stands on a support pier.
    await expect(sim.getByTestId('supports-2').getByTestId('support-leg')).toHaveCount(1);
  });

  test('a deck bridging directly over ground track plants no pier on the rail below', async ({
    browser,
  }) => {
    const sim = await openSimulatorUi(browser);
    await expect(sim.getByTestId('toy-table-canvas')).toBeVisible();

    // A ground rail at table centre.
    await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });

    // A second deck, with a piece placed directly over that ground rail.
    await sim.getByTestId('add-level').click();
    await expect(sim.getByTestId('active-layer-1')).toHaveAttribute('aria-pressed', 'true');
    const deckId = await placePieceOnToyTable(sim, { type: 'straight', xMm: 450, yMm: 300 });

    // The deck piece IS on Level 1 (the bridge crossing is legitimate)...
    await expect(sim.locator(`g[data-layer="1"] [data-piece-id="${deckId}"]`)).toHaveCount(1);
    // ...but its pier is suppressed because ground track runs beneath it, so no
    // support leg is drawn at all (the ground rail itself never carries one).
    await expect(sim.getByTestId('support-leg')).toHaveCount(0);
  });
});
