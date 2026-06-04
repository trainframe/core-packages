import { expect, test } from '@playwright/test';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey: typing a bad broker URL must produce a visible, human-
 * readable error in the Settings form. Subsequent reconnect to a working
 * broker must clear the alert.
 *
 * Covers both the visualiser and simulator-ui because they share identical
 * Settings components.
 */

test.describe
  .serial('Broker error feedback — visualiser', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('bad URL shows error alert; reconnecting to good URL clears it', async ({ browser }) => {
      const page = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });

      // Sanity-check: visualiser starts connected to the harness.
      await expect(page.getByRole('status')).toHaveText(/connected/i, { timeout: 10_000 });

      // Operator opens Settings (already visible) and types a URL that has no
      // broker behind it (port 9999 is unoccupied during the test run).
      const urlInput = page.getByRole('textbox', { name: /broker url/i });
      await urlInput.fill('ws://127.0.0.1:9999');
      await page.getByRole('button', { name: /connect/i }).click();

      // The error alert must appear and mention the broker.
      const errorAlert = page.getByRole('alert');
      await expect(errorAlert).toBeVisible({ timeout: 10_000 });
      await expect(errorAlert).toContainText(/broker/i);

      // Operator corrects the URL back to the working harness.
      await urlInput.fill(harness.brokerWsUrl);
      await page.getByRole('button', { name: /connect/i }).click();

      // The alert disappears and the status badge returns to connected.
      await expect(errorAlert).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByRole('status')).toHaveText(/connected/i, { timeout: 10_000 });
    });
  });

// Port 9002 avoids colliding with the visualiser harness on 9001 above.
// Both describe.serial blocks share the same file and Playwright may initialise
// their beforeAll hooks before the first group's afterAll has run.
const SIM_UI_BROKER_PORT = 9002;

test.describe
  .serial('Broker error feedback — simulator-ui', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: SIM_UI_BROKER_PORT });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('bad URL shows error alert; reconnecting to good URL clears it', async ({ browser }) => {
      const page = await openSimulatorUi(browser, {
        brokerUrl: `ws://127.0.0.1:${SIM_UI_BROKER_PORT}`,
      });

      // Sanity-check: sim-ui starts connected to the harness.
      await expect(page.getByRole('status')).toHaveText(/connected/i, { timeout: 10_000 });

      // Operator opens Settings (already visible) and types a URL that has no
      // broker behind it.
      const urlInput = page.getByRole('textbox', { name: /broker url/i });
      await urlInput.fill('ws://127.0.0.1:9999');
      await page.getByRole('button', { name: /connect/i }).click();

      // The error alert must appear and mention the broker.
      const errorAlert = page.getByRole('alert');
      await expect(errorAlert).toBeVisible({ timeout: 10_000 });
      await expect(errorAlert).toContainText(/broker/i);

      // Operator corrects the URL back to the working harness.
      await urlInput.fill(`ws://127.0.0.1:${SIM_UI_BROKER_PORT}`);
      await page.getByRole('button', { name: /connect/i }).click();

      // The alert disappears and the status badge returns to connected.
      await expect(errorAlert).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByRole('status')).toHaveText(/connected/i, { timeout: 10_000 });
    });
  });
