import { expect, test } from '@playwright/test';
import { AdminHttpServer } from '@trainframe/server';
import { VISUALISER_URL } from '../playwright.config.js';
import {
  openSimulatorUi,
  openVisualiser,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Discovery journey: server boots with an empty layout, the operator places
 * and scans track pieces; the visualiser grows live as markers and edges are
 * inferred.
 *
 * Two lanes:
 *
 * 1. Browser-lane (toy table): place pieces + scan → GARAGE emits
 *    tag_assignment → server upserts markers → visualiser renders them.
 *    After scanning, the in-browser train ticks via RAF; it traverses edges
 *    and emits tag_observed pairs that the server uses to infer edges.
 *
 * 2. Node-lane (injected events): when the browser-lane train can't
 *    self-bootstrap (no outgoing edges yet for LearnMode to consume), we
 *    inject tag_observed pairs directly via `harness.server.injectEvent` so
 *    the edge-inference path is still exercised end-to-end.
 */

let harness: UiHarness;
let admin: AdminHttpServer;
let adminPort: number;

test.describe('Discovery mode: visualiser grows as the operator scans pieces', () => {
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
    await page.waitForFunction(() => {
      const status = document.querySelector('output[data-status]');
      return status?.getAttribute('data-status') === 'connected';
    });
    await page.waitForTimeout(300);
  });

  test('scanning a track piece makes a new marker appear in the visualiser', async ({
    page,
    browser,
  }) => {
    const sim = await openSimulatorUi(browser, { brokerUrl: 'ws://127.0.0.1:9001' });
    await waitForVisualiserConnected(sim);

    const pieceId = await placePieceOnToyTable(sim, { type: 'straight', xMm: 300, yMm: 300 });
    await scanPiece(sim, pieceId);

    const markerId = `M-${pieceId}`;
    await expect(page.locator(`[data-marker-id="${markerId}"]`)).toBeVisible({ timeout: 10_000 });
  });

  test('an unknown tag → operator binds it to a new marker → marker appears in the SVG', async ({
    page,
  }) => {
    // Start with no markers (server is in discovery mode). Inject an unknown tag
    // via a reader device — the visualiser surfaces the assign-tag affordance.
    harness.server.injectEvent('device_registered', 'READER', {
      capabilities: ['core.identifies_vehicles'],
    });
    harness.server.injectEvent('tag_observed', 'READER', { tag_id: 'M-DISCOVERED' });

    const row = page.getByTestId('unknown-tag-M-DISCOVERED');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Operator creates the new marker via the admin API (free-text path).
    const adminUrl = `http://127.0.0.1:${adminPort}`;
    const res = await page.evaluate(
      async ({ url, body }) => {
        const r = await fetch(`${url}/api/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return r.status;
      },
      {
        url: adminUrl,
        body: {
          tag_id: 'M-DISCOVERED',
          assigned_kind: 'marker',
          target_id: 'M-DISCOVERED',
          marker_kind: 'block_boundary',
        },
      },
    );
    expect(res).toBe(204);

    // The new marker now renders in the SVG.
    await expect(page.locator('[data-marker-id="M-DISCOVERED"]')).toBeVisible({ timeout: 5_000 });

    // The unknown-tag affordance has cleared.
    await expect(row).toBeHidden({ timeout: 5_000 });
  });

  test('a train traversing two known markers grows an edge the visualiser renders', async ({
    page,
  }) => {
    // Bind two markers via the GARAGE device (same path as a real scan).
    harness.server.injectEvent('device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    harness.server.injectEvent('tag_assignment', 'GARAGE', {
      tag_id: 'M-A',
      assigned_kind: 'marker',
      target_id: 'M-A',
      marker_kind: 'block_boundary',
    });
    harness.server.injectEvent('tag_assignment', 'GARAGE', {
      tag_id: 'M-B',
      assigned_kind: 'marker',
      target_id: 'M-B',
      marker_kind: 'block_boundary',
    });

    await expect(page.locator('[data-marker-id="M-A"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-marker-id="M-B"]')).toBeVisible({ timeout: 5_000 });

    // Register a train and inject consecutive tag_observed events so the
    // server infers the M-A → M-B edge from the traversal.
    harness.server.injectEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    harness.server.injectEvent('tag_observed', 'T1', { tag_id: 'M-A' });
    harness.server.injectEvent('tag_observed', 'T1', { tag_id: 'M-B' });

    // Edge should appear in LayoutState.
    await expect
      .poll(() => harness.server.getLayoutState().findEdge('M-A', 'M-B') !== undefined, {
        timeout: 5_000,
      })
      .toBe(true);

    // The visualiser's edges group should contain a path for the new edge.
    await expect(page.locator('[data-testid="edges"] path')).not.toHaveCount(0, {
      timeout: 5_000,
    });
  });
});
