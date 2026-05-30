import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from '@trainframe/server';
import { openVisualiser, waitForVisualiserConnected } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Closes the ADR-007 unknown-tag loop end-to-end: the operator binds a
 * mystery tag through the visualiser form, then a later `tag_observed`
 * carrying the same tag — from a train device this time — moves T1 onto
 * the bound marker on the canvas. Proves the registry update reaches the
 * scheduler's resolution path and the resulting `marker_traversed` is
 * what the visualiser draws.
 *
 * `tag-assignment.spec.ts` stops once the registry has the binding and
 * the affordance hides. This spec picks up from there.
 */

const SIMPLE_LOOP: Layout = {
  name: 'unknown-tag-closure',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
    { id: 'M4', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

test.describe
  .serial('Operator binds an unknown tag and the train then lands on it', () => {
    let harness: UiHarness;
    let admin: AdminHttpServer;
    let adminPort: number;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: SIMPLE_LOOP, wsPort: 9001 });
      admin = new AdminHttpServer({ server: harness.server });
      adminPort = await admin.listen(0);
    });

    test.afterAll(async () => {
      await admin.close();
      await harness.shutdown();
    });

    test('after assigning TAG-MYSTERY to M2, a train reporting the tag appears at M2', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser, {
        adminApiUrl: `http://127.0.0.1:${adminPort}`,
      });

      await expect(
        visualiser.getByRole('heading', { name: /Trainframe Visualiser/i }),
      ).toBeVisible();
      await waitForVisualiserConnected(visualiser);

      // A roadside reader sees an unknown tag — the affordance surfaces.
      harness.server.injectEvent('device_registered', 'READER-1', {
        capabilities: ['core.identifies_vehicles'],
      });
      harness.server.injectEvent('tag_observed', 'READER-1', { tag_id: 'TAG-MYSTERY' });

      const row = visualiser.getByTestId('unknown-tag-TAG-MYSTERY');
      await expect(row).toBeVisible({ timeout: 5_000 });

      // Operator picks M2 as the target and submits via the form. After
      // the registry update propagates, the row disappears.
      await visualiser.getByTestId('target-TAG-MYSTERY').selectOption('M2');
      await visualiser.getByTestId('assign-TAG-MYSTERY').click();

      await expect(row).toBeHidden({ timeout: 5_000 });

      // Now a train sees TAG-MYSTERY. The scheduler resolves it to M2 and
      // emits `marker_traversed`, which the visualiser snaps T1 onto.
      harness.server.injectEvent('device_registered', 'T1', {
        capabilities: ['core.controls_motion', 'core.accepts_route'],
      });
      harness.server.injectEvent('tag_observed', 'T1', { tag_id: 'TAG-MYSTERY' });

      const train = visualiser.locator('[data-train-id="T1"]');
      await expect(train).toBeVisible({ timeout: 5_000 });

      await expect
        .poll(async () => train.getAttribute('data-at-marker'), {
          timeout: 10_000,
          message: 'expected T1 to land on M2 after the bound tag was observed',
        })
        .toBe('M2');
    });
  });
