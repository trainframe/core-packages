import { type Page, expect, test } from '@playwright/test';

/**
 * Operator-facing smoke. Each test is framed as "what does the operator do
 * and see?" rather than "what internal state transitions?". The journey
 * regression for multi-train block release lives in multi-train-journey.spec.
 */

/**
 * The default sim-ui starts with the SIMPLE_LOOP preset. The schedule builder
 * starts empty, so every spawn-driving test first picks a stop (M1) to enable
 * the Spawn button — a single stop is sufficient.
 */
async function buildDefaultSchedule(page: Page): Promise<void> {
  await page.getByLabel(/stop/i).selectOption('M1');
  await page.getByRole('button', { name: /add stop/i }).click();
}

test.describe('Simulator UI: operator panel', () => {
  test.beforeEach(async ({ page }) => {
    // Seed the broker URL so the page mounts even before a broker exists —
    // the panel is meant to be usable without a live broker for setup work.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('trainframe.simulator-ui.brokerUrl', 'ws://127.0.0.1:9001');
      } catch {
        /* ignore */
      }
    });
    await page.goto('/');
  });

  test('the operator lands on a ready panel with no trains and Spawn available', async ({
    page,
  }) => {
    await expect(page.getByRole('heading', { name: /Trainframe Simulator/i })).toBeVisible();
    await expect(page.locator('dt:has-text("Trains") + dd')).toHaveText(/none/i);
    // Spawn is gated on building a route — after the operator picks
    // markers, Spawn becomes available.
    await buildDefaultSchedule(page);
    await expect(page.getByRole('button', { name: /spawn train/i })).toBeEnabled();
    // Pause and Stop are not yet meaningful — the operator hasn't started anything.
    await expect(page.getByRole('button', { name: /^pause$/i })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^stop$/i })).toBeDisabled();
  });

  test('after spawning a train, the operator sees it listed in the snapshot', async ({ page }) => {
    await buildDefaultSchedule(page);
    await page.getByRole('button', { name: /spawn train/i }).click();
    await expect(page.locator('dt:has-text("Trains") + dd')).toHaveText(/T1/);
  });

  test('spawning from idle leaves the simulation running so the operator sees motion without further input', async ({
    page,
  }) => {
    await buildDefaultSchedule(page);
    await page.getByRole('button', { name: /spawn train/i }).click();
    await expect(page.getByTestId('sim-status')).toHaveText('running');
  });

  test('stepping the simulation after spawning advances the clock the operator sees', async ({
    page,
  }) => {
    await buildDefaultSchedule(page);
    await page.getByRole('button', { name: /spawn train/i }).click();

    const clock = page.locator('dt:has-text("Sim time") + dd');
    await expect(clock).toHaveText('0.0s');

    await page.getByRole('button', { name: /step 1s/i }).click();
    await expect(clock).not.toHaveText('0.0s');
  });

  test("spawning while paused respects the operator's pause — sim stays paused", async ({
    page,
  }) => {
    // Spawn from idle: auto-resumes, sim runs.
    await buildDefaultSchedule(page);
    await page.getByRole('button', { name: /spawn train/i }).click();
    await expect(page.getByTestId('sim-status')).toHaveText('running');

    // Operator pauses to inspect / adjust.
    await page.getByRole('button', { name: /^pause$/i }).click();
    await expect(page.getByTestId('sim-status')).toHaveText('paused');

    // A second Spawn while paused should add the train but leave the
    // sim paused — the operator paused for a reason and a side-effect
    // resume would override their intent. The route is still on the form
    // from the first spawn, so the second Spawn is enabled.
    await page.getByRole('button', { name: /spawn train/i }).click();
    await expect(page.locator('dt:has-text("Trains") + dd')).toHaveText(/T1, T2/);
    await expect(page.getByTestId('sim-status')).toHaveText('paused');
  });

  test('stopping the sim resets the Train ID field so the next spawn starts at T1 again', async ({
    page,
  }) => {
    const trainIdInput = page.getByRole('textbox', { name: /Train ID/i });
    await expect(trainIdInput).toHaveValue('T1');

    await buildDefaultSchedule(page);
    await page.getByRole('button', { name: /spawn train/i }).click();
    await expect(trainIdInput).toHaveValue('T2');

    await page.getByRole('button', { name: /^stop$/i }).click();
    await expect(page.locator('dt:has-text("Trains") + dd')).toHaveText(/none/i);
    // No trains exist anymore — the form should reflect that.
    await expect(trainIdInput).toHaveValue('T1');
  });

  test('re-using a train ID shows an inline error and the counter does not skip ahead', async ({
    page,
  }) => {
    const trainIdInput = page.getByRole('textbox', { name: /Train ID/i });

    // Spawn T1 — succeeds, counter advances to T2.
    await buildDefaultSchedule(page);
    await page.getByRole('button', { name: /spawn train/i }).click();
    await expect(page.locator('dt:has-text("Trains") + dd')).toHaveText(/T1/);
    await expect(trainIdInput).toHaveValue('T2');

    // Operator types T1 again and tries to spawn.
    await trainIdInput.fill('T1');
    await page.getByRole('button', { name: /spawn train/i }).click();

    // The smoke setup has no live broker, so the broker-error alert is
    // already on the page — match by the conflict text directly, which is
    // both semantic and specific.
    const dupAlert = page.getByText(/T1 already exists/i);
    await expect(dupAlert).toBeVisible();

    // The counter must NOT have advanced — the input stays at T1 (the
    // operator typed), and there's still only one train in the snapshot.
    await expect(page.locator('dt:has-text("Trains") + dd')).toHaveText(/^T1$/);
    await expect(trainIdInput).toHaveValue('T1');

    // Fixing the ID clears the duplicate error.
    await trainIdInput.fill('T2');
    await page.getByRole('button', { name: /spawn train/i }).click();
    await expect(dupAlert).toHaveCount(0);
    await expect(page.locator('dt:has-text("Trains") + dd')).toHaveText(/T1, T2/);
  });

  test('applying a no-stop schedule disables Spawn and shows an explanatory hint', async ({
    page,
  }) => {
    // Paste a layout with markers but no edges. The operator has markers to
    // pick as stops, but has not picked any yet, so Spawn remains disabled.
    const edgelessJson = JSON.stringify(
      {
        name: 'edgeless-test',
        markers: [{ id: 'M1', kind: 'block_boundary' }],
        edges: [],
        junctions: [],
      },
      null,
      2,
    );

    await page.getByLabel(/Source/i).selectOption('custom');
    await page.getByLabel(/Layout JSON/i).fill(edgelessJson);
    await page.getByRole('button', { name: /Apply layout/i }).click();

    // Spawn must be disabled with no ambiguity.
    await expect(page.getByRole('button', { name: /spawn train/i })).toBeDisabled();
    // The operator gets a clear explanation, not just a greyed-out button.
    await expect(page.getByTestId('spawn-stops-hint')).toBeVisible();
    await expect(page.getByTestId('spawn-stops-hint')).toContainText(/stop/i);
  });
});
