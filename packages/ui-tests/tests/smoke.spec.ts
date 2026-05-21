import { expect, test } from '@playwright/test';

test.describe('Simulator UI: lifecycle smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Pre-seed localStorage so the page renders even before the broker harness
    // is up. The broker URL doesn't need to be reachable for the basic
    // SimRunner lifecycle controls to function.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('trainframe.simulator-ui.brokerUrl', 'ws://127.0.0.1:9001');
      } catch {
        /* ignore */
      }
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Trainframe Simulator/i })).toBeVisible();
  });

  test('clicking Start moves the simulation from idle to paused', async ({ page }) => {
    const status = page.getByTestId('sim-status');
    await expect(status).toHaveText('idle');

    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(status).toHaveText('paused');
  });

  test('clicking Spawn registers a train and surfaces it in the snapshot', async ({ page }) => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: /Spawn train/i }).click();

    const trainsRow = page.locator('dt:has-text("Trains") + dd');
    await expect(trainsRow).toHaveText(/T1/);
  });

  test('Resume + Step advances the sim clock', async ({ page }) => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: /Spawn train/i }).click();

    const stepButton = page.getByRole('button', { name: /Step 1s/ });
    await stepButton.click();

    const simTime = page.locator('dt:has-text("Sim time") + dd');
    await expect(simTime).not.toHaveText('0.0s');
  });
});
