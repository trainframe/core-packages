import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { MqttBrokerClient } from '@trainframe/simulator';
import { openVisualiser, waitForVisualiserConnected } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Garage introduction flow over the LIVE stack (ADR-036 Layer 4).
 *
 * Full real path: a train device registers on the bus WITHOUT `introduced`
 * in its retained snapshot — the visualiser garage must show it in the
 * "awaiting introduction" list. The operator clicks the Introduce button —
 * the visualiser publishes `railway/operator/introduce_train`. A second pass
 * publishes the retained snapshot with `introduced: true` and asserts the
 * row disappears.
 *
 * Adversarial refutations:
 *   - A train with `introduced: true` must NOT appear in the list.
 *   - Clicking Introduce must publish the correct `train_id`.
 *   - The row must drop once the snapshot arrives with `introduced: true`.
 */

/**
 * Publish a RETAINED device snapshot (the shape the server writes to
 * `railway/state/devices/<id>`) so the visualiser sees it on subscribe.
 */
function retainedSnapshot(
  bus: MqttBrokerClient,
  deviceId: string,
  extra: Record<string, unknown> = {},
): void {
  bus.publish(
    `railway/state/devices/${deviceId}`,
    new TextEncoder().encode(
      JSON.stringify({
        capabilities: [
          'core.controls_motion',
          'core.reports_marker_traversal',
          'core.accepts_route',
        ],
        train_length_mm: 150,
        ...extra,
      }),
    ),
  );
}

test.describe
  .serial('garage-introduce: operator gestures a train introduction via the visualiser', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9116 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('an un-introduced train appears in the garage, Introduce publishes the gesture, row drops on introduced:true', async ({
      browser,
    }) => {
      test.setTimeout(90_000);
      const vis = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
      await waitForVisualiserConnected(vis);

      const bus = new MqttBrokerClient();
      bus.connect(harness.brokerWsUrl);
      await vis.waitForTimeout(400);

      /* 1. Publish a retained device snapshot WITHOUT introduced — this is what the server
       *    emits for a registered-but-not-yet-introduced train. The visualiser subscribes
       *    to `railway/state/devices/+` so the retained publish reaches it immediately. */
      retainedSnapshot(bus, 'T-intro', {});

      /* 2. Assert the garage section appears and shows the train. */
      await expect(vis.getByTestId('garage-introduction')).toBeVisible({ timeout: 15_000 });
      await expect(vis.getByTestId('introduce-item-T-intro')).toBeVisible({ timeout: 15_000 });

      /* Visual artifact of the LIVE garage flow: the "awaiting introduction" section
       *  itself (scrolled into view), showing the train row + its Introduce button. */
      const shotDir = resolve(import.meta.dirname, '..', 'screenshots');
      mkdirSync(shotDir, { recursive: true });
      await vis.getByTestId('garage-introduction').scrollIntoViewIfNeeded();
      await vis.getByTestId('garage-introduction').screenshot({
        path: resolve(shotDir, 'garage-awaiting-introduction.png'),
      });

      /* 3. Confirm a train with introduced:true does NOT appear.
       *    Publish a second device that is already introduced. */
      retainedSnapshot(bus, 'T-done', { introduced: true });
      await vis.waitForTimeout(500);
      await expect(vis.getByTestId('introduce-item-T-done')).toHaveCount(0);

      /* 4. Click Introduce and assert the operator gesture is published. */
      const publishedGestures: Array<{ topic: string; payload: Uint8Array }> = [];
      bus.subscribe('railway/operator/introduce_train', (msg) => {
        publishedGestures.push({ topic: msg.topic, payload: msg.payload });
      });
      await vis.waitForTimeout(200);
      await vis.getByTestId('introduce-btn-T-intro').click();

      /* Wait for the gesture to arrive on the broker. */
      await expect
        .poll(() => publishedGestures.length, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(1);

      const latest = publishedGestures[publishedGestures.length - 1];
      expect(latest).toBeDefined();
      if (latest !== undefined) {
        const body = JSON.parse(new TextDecoder().decode(latest.payload)) as {
          train_id?: unknown;
        };
        expect(body.train_id).toBe('T-intro');
      }

      /* 5. Server (simulated here by a direct retained publish) resolves the
       *    introduction — update the retained snapshot to introduced:true.
       *    The row should now disappear from the garage list. */
      retainedSnapshot(bus, 'T-intro', { introduced: true });
      await expect(vis.getByTestId('introduce-item-T-intro')).toHaveCount(0, { timeout: 10_000 });

      /* If no trains remain in the list the section itself should vanish. */
      await expect(vis.getByTestId('garage-introduction')).toHaveCount(0);

      /* Visual artifact after introduction: the row is gone (train is on the track). */
      await vis.screenshot({ path: resolve(shotDir, 'garage-after-introduction.png') });

      bus.disconnect();
      await vis.context().close();
    });
  });
