import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, placePieceOnToyTable, scanPiece } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey for the Experiments box (docs/experimental 001–005): the
 * shelf offers the five viability-test pieces apart from the staples, and the
 * three with moving parts respond to the operator on the table — a lift
 * bridge's span raises and reseats, a turntable's deck spins stub to stub, and
 * a vision station's LED lights when a train sits under its sensor. All
 * observations are what a person at the table would see (data-* attributes on
 * the visible moving parts), not internal state.
 */

const EMPTY: Layout = { name: 'experiments', markers: [], edges: [], junctions: [] };

/** Disarm whatever toybox tool is still armed, so the next click selects a
 * piece instead of placing another one. */
async function disarm(sim: Page): Promise<void> {
  const armed = sim.locator('.tf-toybox__button[aria-pressed="true"]');
  if ((await armed.count()) > 0) await armed.first().click();
}

test.describe
  .serial('Experiments box — viability-test pieces on the toy table', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      // A dedicated broker port: this spec must not collide with a dev broker
      // (or another spec) on the default 9001.
      harness = await startUiHarness({ layout: EMPTY, wsPort: 9301 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('the shelf offers the Experiments box with all five pieces', async ({ browser }) => {
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });
      for (const type of [
        'vision-station',
        'turntable',
        'crane-station',
        'decoupler',
        'lift-bridge',
      ]) {
        await expect(sim.getByTestId(`toybox-${type}`)).toBeVisible();
      }
      await sim.close();
    });

    test('raise/lower a lift bridge span; spin a turntable deck; a vision station lights over a parked train', async ({
      browser,
    }) => {
      const sim = await openSimulatorUi(browser, { brokerUrl: harness.brokerWsUrl });

      /* Lift bridge in a line of track, scanned live. The span starts seated;
       * the explicit affordance raises it (a real clearance withhold across
       * its own marker) and lowers it again. */
      await placePieceOnToyTable(sim, { type: 'straight', xMm: 250, yMm: 300 });
      const bridgeId = await placePieceOnToyTable(sim, { type: 'lift-bridge', xMm: 450, yMm: 300 });
      await placePieceOnToyTable(sim, { type: 'straight', xMm: 650, yMm: 300 });
      await scanPiece(sim, bridgeId);
      await disarm(sim);

      const span = sim.getByTestId(`bridge-span-${bridgeId}`);
      await expect(span).toHaveAttribute('data-raised', 'false');
      await sim.getByTestId(`piece-${bridgeId}`).click();
      await sim.getByTestId('action-raise-span').click();
      await expect(span).toHaveAttribute('data-raised', 'true');
      await sim.getByTestId('action-lower-span').click();
      await expect(span).toHaveAttribute('data-raised', 'false');

      /* Turntable: the deck rests on the east stub; each spin seats and
       * confirms the next stub — the branch choice as a visible angle. */
      const turntableId = await placePieceOnToyTable(sim, {
        type: 'turntable',
        xMm: 650,
        yMm: 120,
      });
      await scanPiece(sim, turntableId);
      await disarm(sim);

      const deck = sim.getByTestId(`turntable-deck-${turntableId}`);
      await expect(deck).toHaveAttribute('data-angle', '0');
      await sim.getByTestId(`piece-${turntableId}`).click();
      await sim.getByTestId('action-spin-deck').click();
      await expect(deck).toHaveAttribute('data-angle', '45');
      await sim.getByTestId('action-spin-deck').click();
      await expect(deck).toHaveAttribute('data-angle', '-45');

      /* Vision station: defined by stillness — its only motion is the
       * detection LED, dark until a live train sits under the sensor. */
      const stationId = await placePieceOnToyTable(sim, {
        type: 'vision-station',
        xMm: 250,
        yMm: 480,
      });
      const led = sim.getByTestId(`vision-led-${stationId}`);
      await expect(led).toHaveAttribute('data-lit', 'false');

      const trainId = await placePieceOnToyTable(sim, { type: 'train', xMm: 250, yMm: 480 });
      await scanPiece(sim, trainId);
      await expect(led).toHaveAttribute('data-lit', 'true');

      await sim.close();
    });
  });
