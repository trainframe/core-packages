import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from '@trainframe/server';
import { VISUALISER_URL } from '../playwright.config.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

const SIMPLE_LOOP: Layout = {
  name: 'simple-loop-tag-assignment',
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

let harness: UiHarness;
let admin: AdminHttpServer;
let adminPort: number;

test.describe('Visualiser: operator assigns a previously-unknown tag', () => {
  test.beforeAll(async () => {
    harness = await startUiHarness({ layout: SIMPLE_LOOP, wsPort: 9001 });
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

  test('Given an unknown tag is observed, when the operator picks a target and clicks Assign, the binding lands in the registry and the row disappears', async ({
    page,
  }) => {
    // Publish a tag_observed for a tag that the server's TagRegistry has
    // never seen. The scheduler responds with an anomaly that the
    // visualiser surfaces in its "Unknown tags" panel.
    await page.waitForFunction(() => {
      const status = document.querySelector('output[data-status]');
      return status?.getAttribute('data-status') === 'connected';
    });
    // The MQTT subscribe ack happens after the `connected` status flip;
    // give it a tick to land before publishing events the UI must see.
    await page.waitForTimeout(300);

    // Register a fake reader device first so the scheduler routes its
    // tag_observed properly.
    harness.server.injectEvent('device_registered', 'READER-1', {
      capabilities: ['core.identifies_vehicles'],
    });
    harness.server.injectEvent('tag_observed', 'READER-1', { tag_id: 'TAG-MYSTERY' });

    const row = page.getByTestId('unknown-tag-TAG-MYSTERY');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Operator picks M2 as the target and submits.
    await page.getByTestId('target-TAG-MYSTERY').selectOption('M2');
    await page.getByTestId('assign-TAG-MYSTERY').click();

    // The server's registry should now have the binding.
    await expect
      .poll(() => harness.server.getScheduler().getTagRegistry().resolve('TAG-MYSTERY'), {
        timeout: 5_000,
      })
      .toEqual({ kind: 'marker', target_id: 'M2' });

    // The visualiser drops the affordance once the retained state lands.
    await expect(row).toBeHidden({ timeout: 5_000 });
  });

  test('Given the operator picks "vehicle" kind, the registry stores the binding as a vehicle', async ({
    page,
  }) => {
    await page.waitForFunction(() => {
      const status = document.querySelector('output[data-status]');
      return status?.getAttribute('data-status') === 'connected';
    });
    await page.waitForTimeout(300);

    harness.server.injectEvent('device_registered', 'GARAGE-1', {
      capabilities: ['core.identifies_vehicles'],
    });
    harness.server.injectEvent('tag_observed', 'GARAGE-1', { tag_id: 'TAG-TRAIN-1' });

    const row = page.getByTestId('unknown-tag-TAG-TRAIN-1');
    await expect(row).toBeVisible({ timeout: 5_000 });

    await page.getByTestId('kind-TAG-TRAIN-1').selectOption('vehicle');
    // For vehicle target we still pick from the marker list (the UI doesn't
    // yet enumerate trains separately). M2 is just a placeholder ID here.
    await page.getByTestId('target-TAG-TRAIN-1').selectOption('M2');
    await page.getByTestId('assign-TAG-TRAIN-1').click();

    await expect
      .poll(() => harness.server.getScheduler().getTagRegistry().resolve('TAG-TRAIN-1'), {
        timeout: 5_000,
      })
      .toEqual({ kind: 'vehicle', target_id: 'M2' });
  });
});
