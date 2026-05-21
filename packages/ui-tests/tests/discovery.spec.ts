import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from '@trainframe/server';
import { VISUALISER_URL } from '../playwright.config.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Discovery journey: server boots with a minimal layout (one marker), the
 * operator assigns an unknown tag to a brand-new marker, then a train
 * traversing the pair grows the graph live in the visualiser.
 */
const SEED: Layout = {
  name: 'discovery-journey',
  markers: [{ id: 'M1', kind: 'block_boundary' }],
  edges: [],
  junctions: [],
};

let harness: UiHarness;
let admin: AdminHttpServer;
let adminPort: number;

test.describe('Discovery mode: the visualiser grows as the operator learns the track', () => {
  test.beforeAll(async () => {
    harness = await startUiHarness({ layout: SEED, wsPort: 9001 });
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

  test('an unknown tag → operator binds it to a new marker → marker appears in the SVG', async ({
    page,
  }) => {
    // Visualiser starts with one marker (M1).
    await expect(page.locator('[data-marker-id="M1"]')).toBeVisible();
    await expect(page.locator('[data-marker-id="M-DISCOVERED"]')).toHaveCount(0);

    // A train sees an unknown tag.
    harness.server.injectEvent('device_registered', 'READER', {
      capabilities: ['core.identifies_vehicles'],
    });
    harness.server.injectEvent('tag_observed', 'READER', { tag_id: 'M-DISCOVERED' });

    // The visualiser surfaces the assign-tag form.
    const row = page.getByTestId('unknown-tag-M-DISCOVERED');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Operator types the new marker's id - since it doesn't exist in the
    // layout yet, the target dropdown shows only existing markers. We can't
    // pick M-DISCOVERED there. Instead, the operator binds the tag to M1
    // (existing) - the form supports targets that ARE in the layout. The
    // *creating-a-new-marker* path runs when target_id doesn't exist yet,
    // which happens if a future UI adds a free-text target field. For the
    // present journey we POST directly via the admin API to exercise the
    // discovery path end-to-end.
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

    // The new marker now renders in the SVG, courtesy of the layout
    // retained-state republish.
    await expect(page.locator('[data-marker-id="M-DISCOVERED"]')).toBeVisible({ timeout: 5_000 });

    // The unknown-tag affordance has cleared.
    await expect(row).toBeHidden({ timeout: 5_000 });
  });

  test('a train traversing the new marker pair grows an edge that the visualiser renders', async ({
    page,
  }) => {
    // Bind a tag for a brand-new marker M-EDGE-NEW.
    harness.server.injectEvent('device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    harness.server.injectEvent('tag_assignment', 'GARAGE', {
      tag_id: 'M-EDGE-NEW',
      assigned_kind: 'marker',
      target_id: 'M-EDGE-NEW',
      marker_kind: 'block_boundary',
    });
    // Also bind M1 so tag_observed for it resolves.
    harness.server.injectEvent('tag_assignment', 'GARAGE', {
      tag_id: 'M1',
      assigned_kind: 'marker',
      target_id: 'M1',
    });
    await expect(page.locator('[data-marker-id="M-EDGE-NEW"]')).toBeVisible({ timeout: 5_000 });

    // Train sees M1 then M-EDGE-NEW: scheduler infers the edge.
    harness.server.injectEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    harness.server.injectEvent('tag_observed', 'T1', { tag_id: 'M1' });
    harness.server.injectEvent('tag_observed', 'T1', { tag_id: 'M-EDGE-NEW' });

    await expect
      .poll(() => harness.server.getLayoutState().findEdge('M1', 'M-EDGE-NEW') !== undefined, {
        timeout: 5_000,
      })
      .toBe(true);

    // The visualiser's `edges` group should contain a line for the new
    // edge (rendered by LayoutCanvas via the keyed map).
    await expect(
      page.locator('[data-testid="edges"] line').filter({ has: page.locator(':scope') }),
    ).not.toHaveCount(0);
  });
});
