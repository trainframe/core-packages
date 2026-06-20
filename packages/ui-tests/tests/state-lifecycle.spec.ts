import { expect, test } from '@playwright/test';
import { AdminHttpServer } from '@trainframe/server';
import { VISUALISER_URL } from '../playwright.config.js';
import { waitForVisualiserConnected } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/*
 * End-to-end journey: state lifecycle through the real harness.
 *
 * Covers the server admin HTTP endpoints and the visualiser's per-train Delete
 * and MaintenancePanel, wired together through a real aedes broker:
 *
 *  1. Spawn two trains (injected via injectEvent — no physics world needed).
 *  2. Confirm both device-row-T1 and device-row-T2 appear in DevicesPanel.
 *  3. Delete T1 via the UI (Delete → Confirm delete).
 *  4. Assert T1's row disappears; T2's row survives.
 *  5. Prune orphaned markers (Prune orphaned markers → Confirm prune).
 *  6. Assert the maintenance panel reports a result.
 *  7. Blank slate (Blank slate → type RESET → Confirm blank slate).
 *  8. Assert the trains group returns to "No trains registered yet."
 *     and the markers group to "No markers on the layout yet."
 *
 * The visualiser page is opened via the `page` Playwright fixture with
 * `addInitScript` (the same pattern as tag-assignment.spec.ts) rather than
 * `openVisualiser(browser, …)`, because the admin HTTP fetch must reach the
 * harness's loopback listener from the browser context.
 */

let harness: UiHarness;
let admin: AdminHttpServer;
let adminPort: number;

test.describe('state lifecycle: delete, prune, blank slate', () => {
  test.beforeAll(async () => {
    harness = await startUiHarness({ discovery: true, wsPort: 9001 });
    admin = new AdminHttpServer({ server: harness.server });
    adminPort = await admin.listen(0);
  });

  test.afterAll(async () => {
    await admin.close();
    await harness.shutdown();
  });

  test.beforeEach(async ({ page }) => {
    const adminUrl = `http://127.0.0.1:${adminPort}`;
    await page.addInitScript(
      ({ broker, admin }) => {
        localStorage.setItem('trainframe.visualiser.brokerUrl', broker);
        localStorage.setItem('trainframe.visualiser.adminApiUrl', admin);
      },
      { broker: 'ws://127.0.0.1:9001', admin: adminUrl },
    );
    await page.goto(VISUALISER_URL);
    await expect(page.getByRole('heading', { name: /Trainframe Visualiser/i })).toBeVisible();
  });

  test('spawn two trains, delete one, prune, blank slate', async ({ page }) => {
    const vis = page;
    await waitForVisualiserConnected(vis);

    /* Register two train devices so the DevicesPanel populates. */
    harness.server.injectEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    harness.server.injectEvent('device_registered', 'T2', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });

    const trainsGroup = vis.getByTestId('devices-trains-group');
    const rowT1 = vis.getByTestId('device-row-T1');
    const rowT2 = vis.getByTestId('device-row-T2');

    /* Both rows must appear before we interact. */
    await expect(rowT1).toBeVisible({ timeout: 8_000 });
    await expect(rowT2).toBeVisible({ timeout: 8_000 });

    /* Step 3: delete T1 — click Delete, then Confirm delete. */
    await rowT1.getByRole('button', { name: 'Delete' }).click();
    await rowT1.getByRole('button', { name: 'Confirm delete' }).click();

    /* T1 must vanish; T2 must survive. */
    await expect(rowT1).toBeHidden({ timeout: 8_000 });
    await expect(rowT2).toBeVisible();

    /* Step 5: prune orphaned markers. */
    const maintenancePanel = vis.getByTestId('maintenance-panel');
    await maintenancePanel.getByRole('button', { name: 'Prune orphaned markers' }).click();
    await maintenancePanel.getByRole('button', { name: 'Confirm prune' }).click();

    /* The <output> element carries the implicit ARIA role "status". */
    await expect(maintenancePanel.getByRole('status')).toBeVisible({ timeout: 8_000 });

    /* Step 7: blank slate — arm, type the phrase, confirm. */
    await maintenancePanel.getByRole('button', { name: 'Blank slate' }).click();
    await maintenancePanel.getByRole('textbox', { name: /RESET/i }).fill('RESET');
    await maintenancePanel.getByRole('button', { name: 'Confirm blank slate' }).click();

    /* Both device groups return to their empty hints. */
    await expect(trainsGroup.getByText('No trains registered yet.')).toBeVisible({
      timeout: 8_000,
    });
    const markersGroup = vis.getByTestId('devices-markers-group');
    await expect(markersGroup.getByText('No markers on the layout yet.')).toBeVisible({
      timeout: 8_000,
    });
  });
});
