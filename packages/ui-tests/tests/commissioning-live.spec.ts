import { expect, test } from '@playwright/test';
import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/simulator';
import { openVisualiser, waitForVisualiserConnected } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Garage commissioning over the LIVE stack (goal criteria 6 & 7, UI half).
 *
 * The full real path: a device appears on the bus (capabilities only), the
 * operator commissions it in the visualiser (classify Train → measured length →
 * confirm; NO naming — ADR-035), the server merges the profile into the retained
 * snapshot, and the device row shows the device + length. A reload proves a LATE client
 * still sees the commissioned profile. The passing assertions ARE the adversarial
 * refutations: a scan that never queues, a confirm that drops name/length, and a
 * late client missing the profile would each fail this test. Records a video for
 * the criterion-7 frame-by-frame review.
 */

const VIDEO_DIR = new URL('../videos/commissioning/', import.meta.url).pathname;

function deviceRegistered(deviceId: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      event_id: `evt-${deviceId}`,
      device_id: deviceId,
      timestamp_device: '2026-06-23T00:00:00.000Z',
      event_type: 'device_registered',
      protocol_version: PROTOCOL_VERSION,
      payload,
    }),
  );
}

test.describe
  .serial('commissioning: a scanned device commissions live (no naming); it survives a reload', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ discovery: true, wsPort: 9115 });
    });
    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('a scanned train queues → operator measures it (no naming) → device row shows it → survives reload', async ({
      browser,
    }) => {
      test.setTimeout(120_000);
      const vis = await openVisualiser(browser, {
        brokerUrl: harness.brokerWsUrl,
        recordVideoDir: VIDEO_DIR,
      });
      await waitForVisualiserConnected(vis);

      // A train appears on the bus carrying ONLY its self-declared capabilities.
      const bus = new MqttBrokerClient();
      bus.connect(harness.brokerWsUrl);
      await vis.waitForTimeout(400);
      bus.publish(
        'railway/events/device_registered/T-loco',
        deviceRegistered('T-loco', {
          capabilities: ['core.controls_motion', 'core.accepts_route'],
          device_kind_hint: 'train',
        }),
      );

      // It QUEUES for commissioning, suggested as a train. (Refutes "scan never queues".)
      await expect(vis.getByTestId('commission-item-T-loco')).toBeVisible({ timeout: 30_000 });
      await expect(vis.getByTestId('commission-category-T-loco')).toHaveValue('train');

      // The operator enters the measured length, then confirms — NO naming
      // (ADR-035): a device self-declares its kind and is known by its id.
      await expect(vis.getByTestId('commission-name-T-loco')).toHaveCount(0);
      await vis.getByTestId('commission-length-T-loco').fill('180');
      await vis.waitForTimeout(400); // legible on camera
      await vis.getByTestId('commission-confirm-T-loco').click();

      // Re-announce → server merge → the DEVICE ROW shows the device + length.
      // (Refutes "confirm drops the length".)
      await expect(vis.getByTestId('device-row-T-loco')).toContainText('T-loco', {
        timeout: 30_000,
      });
      await expect(vis.getByTestId('device-length-T-loco')).toHaveText('180 mm');
      // It left the commission queue.
      await expect(vis.getByTestId('commission-item-T-loco')).toHaveCount(0);
      await vis.waitForTimeout(900);

      // RELOAD — a fresh (late) client still sees the commissioned profile.
      // (Refutes "late client missing the profile".)
      await vis.reload({ waitUntil: 'domcontentloaded' });
      await waitForVisualiserConnected(vis);
      await expect(vis.getByTestId('device-row-T-loco')).toContainText('T-loco', {
        timeout: 30_000,
      });
      await expect(vis.getByTestId('device-length-T-loco')).toHaveText('180 mm');
      // Hold the re-populated post-reload state on camera long enough that the
      // recording clearly shows the named device SURVIVING the reload (a short
      // hold gets truncated mid-reconnect by the video flush).
      await vis.waitForTimeout(3000);

      bus.disconnect();
      // Close the context so Playwright finalises the recorded video (a manually
      // created context is not auto-closed by the test runner).
      await vis.context().close();
    });
  });
