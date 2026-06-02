import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from '@trainframe/server';
import mqtt from 'mqtt';
import { SIM_URL, VISUALISER_URL } from '../playwright.config.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Visual capture suite. Not assertion-heavy: drives the UIs through each
 * feature state, then takes screenshots into `screenshots/` so reviewers
 * can scan the output without running the apps locally.
 */

const SCREENSHOT_DIR = resolve(import.meta.dirname, '..', 'screenshots');

mkdirSync(SCREENSHOT_DIR, { recursive: true });

const SIMPLE_LOOP: Layout = {
  name: 'showcase-loop',
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

const DISCOVERY_SEED: Layout = {
  name: 'showcase-discovery',
  markers: [{ id: 'M1', kind: 'block_boundary' }],
  edges: [],
  junctions: [],
};

const settle = (page: import('@playwright/test').Page) => page.waitForTimeout(400);

test.describe
  .serial('feature showcase: screenshots', () => {
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

    const seedVisualiser = async (page: import('@playwright/test').Page) => {
      const adminUrl = `http://127.0.0.1:${adminPort}`;
      await page.addInitScript(
        ({ broker, admin }) => {
          localStorage.setItem('trainframe.visualiser.brokerUrl', broker);
          localStorage.setItem('trainframe.visualiser.adminApiUrl', admin);
        },
        { broker: 'ws://127.0.0.1:9001', admin: adminUrl },
      );
    };

    test('visualiser: connected to a populated layout', async ({ page }) => {
      await seedVisualiser(page);
      await page.goto(VISUALISER_URL);
      await expect(page.locator('[data-marker-id="M1"]')).toBeVisible();
      await settle(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, '01-visualiser-simple-loop.png'),
        fullPage: true,
      });
    });

    test('visualiser: train sitting at a marker after marker_traversed', async ({ page }) => {
      await seedVisualiser(page);
      await page.goto(VISUALISER_URL);
      await expect(page.locator('[data-marker-id="M1"]')).toBeVisible();
      await settle(page);

      // Register garage + bind identity tags so tag_observed resolves.
      harness.server.injectEvent('device_registered', 'GARAGE', {
        capabilities: ['core.assigns_tags'],
      });
      for (const id of ['M1', 'M2', 'M3', 'M4']) {
        harness.server.injectEvent('tag_assignment', 'GARAGE', {
          tag_id: id,
          assigned_kind: 'marker',
          target_id: id,
        });
      }
      harness.server.injectEvent('device_registered', 'T1', {
        capabilities: ['core.controls_motion', 'core.accepts_route'],
      });
      harness.server.injectEvent('tag_observed', 'T1', { tag_id: 'M2' });

      await expect(page.locator('[data-train-id="T1"]')).toBeVisible();
      await settle(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, '02-visualiser-train-at-marker.png'),
        fullPage: true,
      });
    });

    test('visualiser: train interpolated mid-edge from train_status', async ({ page }) => {
      await seedVisualiser(page);
      await page.goto(VISUALISER_URL);
      await expect(page.locator('[data-marker-id="M1"]')).toBeVisible();
      await settle(page);

      // train_status is normally emitted by the train firmware. For this
      // capture we publish it directly via a Node mqtt client so the
      // visualiser sees a mid-edge position.
      harness.server.injectEvent('device_registered', 'T1', {
        capabilities: ['core.controls_motion', 'core.accepts_route'],
      });
      const client = mqtt.connect(harness.brokerWsUrl, { protocolVersion: 4 });
      await new Promise<void>((res) => client.on('connect', () => res()));
      client.publish(
        'railway/events/train_status/T1',
        JSON.stringify({
          event_id: 'showcase-status-1',
          device_id: 'T1',
          timestamp_device: new Date().toISOString(),
          event_type: 'train_status',
          protocol_version: '0.2.0',
          payload: {
            train_id: 'T1',
            current_edge: { from_marker_id: 'M2', to_marker_id: 'M3' },
            estimated_distance_from_edge_start_mm: 100,
            speed_normalised: 0.5,
          },
        }),
      );
      await page.waitForFunction(() => {
        const node = document.querySelector('[data-train-id="T1"]');
        return node?.getAttribute('data-on-edge') === 'M2->M3';
      });
      await settle(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, '03-visualiser-train-mid-edge.png'),
        fullPage: true,
      });
      client.end();
    });

    test('visualiser: unknown-tag affordance with the assign form', async ({ page }) => {
      await seedVisualiser(page);
      await page.goto(VISUALISER_URL);
      await expect(page.locator('[data-marker-id="M1"]')).toBeVisible();
      await settle(page);

      harness.server.injectEvent('device_registered', 'READER', {
        capabilities: ['core.identifies_vehicles'],
      });
      harness.server.injectEvent('tag_observed', 'READER', { tag_id: 'TAG-MYSTERY-001' });
      await expect(page.getByTestId('unknown-tag-TAG-MYSTERY-001')).toBeVisible();
      await settle(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, '04-visualiser-unknown-tag.png'),
        fullPage: true,
      });
    });

    test('visualiser: discovery — new marker materialises live', async ({ page }) => {
      // Reset to the discovery-seed layout for this scenario.
      await admin.close();
      await harness.shutdown();
      harness = await startUiHarness({ layout: DISCOVERY_SEED, wsPort: 9001 });
      admin = new AdminHttpServer({ server: harness.server });
      adminPort = await admin.listen(0);

      await seedVisualiser(page);
      await page.goto(VISUALISER_URL);
      await expect(page.locator('[data-marker-id="M1"]')).toBeVisible();
      await settle(page);

      harness.server.injectEvent('device_registered', 'GARAGE', {
        capabilities: ['core.assigns_tags'],
      });
      harness.server.injectEvent('tag_assignment', 'GARAGE', {
        tag_id: 'M-DISCOVERED',
        assigned_kind: 'marker',
        target_id: 'M-DISCOVERED',
        marker_kind: 'station_stop',
      });
      await expect(page.locator('[data-marker-id="M-DISCOVERED"]')).toBeVisible();
      await settle(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, '05-visualiser-discovered-marker.png'),
        fullPage: true,
      });
    });

    test('visualiser: inferred edge after a train traverses both markers', async ({ page }) => {
      await seedVisualiser(page);
      await page.goto(VISUALISER_URL);
      await expect(page.locator('[data-marker-id="M1"]')).toBeVisible();
      await expect(page.locator('[data-marker-id="M-DISCOVERED"]')).toBeVisible();
      await settle(page);

      // Bind M1's tag too so the second tag_observed resolves.
      harness.server.injectEvent('tag_assignment', 'GARAGE', {
        tag_id: 'M1',
        assigned_kind: 'marker',
        target_id: 'M1',
      });
      harness.server.injectEvent('device_registered', 'T1', {
        capabilities: ['core.controls_motion', 'core.accepts_route'],
      });
      harness.server.injectEvent('tag_observed', 'T1', { tag_id: 'M1' });
      harness.server.injectEvent('tag_observed', 'T1', { tag_id: 'M-DISCOVERED' });

      await expect
        .poll(() => harness.server.getLayoutState().findEdge('M1', 'M-DISCOVERED') !== undefined, {
          timeout: 3_000,
        })
        .toBe(true);
      await settle(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, '06-visualiser-inferred-edge.png'),
        fullPage: true,
      });
    });

    test('simulator-ui: lifecycle controls after spawn', async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('trainframe.simulator-ui.brokerUrl', 'ws://127.0.0.1:9001');
      });
      await page.goto(SIM_URL);
      await expect(page.getByRole('heading', { name: /Trainframe Simulator/i })).toBeVisible();
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      for (const stop of ['M1', 'M3']) {
        await page.getByRole('combobox', { name: /stop/i }).selectOption(stop);
        await page.getByRole('button', { name: /add stop/i }).click();
      }
      await page.getByRole('button', { name: /Spawn train/i }).click();
      await settle(page);
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, '07-simulator-ui.png'),
        fullPage: true,
      });
    });
  });
