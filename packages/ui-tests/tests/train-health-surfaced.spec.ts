import { expect, test } from '@playwright/test';
import mqtt from 'mqtt';
import { openVisualiser, waitForVisualiserConnected } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator-facing journey: a train reports a low battery and a fault over
 * `train_status`, and the visualiser (the ADR-013 system view) surfaces both
 * as machine-checkable `data-*` attributes on the train node. battery + error
 * are emitted by firmware, so — as in the mid-edge showcase test — we publish
 * the event directly via a Node mqtt client rather than driving the sim.
 */

const HEALTH_LAYOUT = {
  name: 'health-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' as const },
    { id: 'M2', kind: 'block_boundary' as const },
    { id: 'M3', kind: 'station_stop' as const },
    { id: 'M4', kind: 'block_boundary' as const },
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

test.describe('visualiser surfaces train battery + error_state', () => {
  test.beforeAll(async () => {
    harness = await startUiHarness({ layout: HEALTH_LAYOUT, wsPort: 9001 });
  });

  test.afterAll(async () => {
    await harness.shutdown();
  });

  test('a low battery and a fault appear as data-* on the train node', async ({ browser }) => {
    const vis = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });
    await waitForVisualiserConnected(vis);
    await expect(vis.locator('[data-marker-id="M1"]')).toBeVisible();

    harness.server.injectEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });

    const client = mqtt.connect(harness.brokerWsUrl, { protocolVersion: 4 });
    await new Promise<void>((res) => client.on('connect', () => res()));
    client.publish(
      'railway/events/train_status/T1',
      JSON.stringify({
        event_id: 'health-status-1',
        device_id: 'T1',
        timestamp_device: new Date().toISOString(),
        event_type: 'train_status',
        protocol_version: '0.2.0',
        payload: {
          train_id: 'T1',
          current_edge: { from_marker_id: 'M2', to_marker_id: 'M3' },
          estimated_distance_from_edge_start_mm: 100,
          speed_normalised: 0.4,
          battery_normalised: 0.1,
          error_state: 'motor_stall',
        },
      }),
    );

    await expect
      .poll(() => vis.locator('[data-train-id="T1"]').getAttribute('data-error-state'), {
        timeout: 10_000,
      })
      .toBe('motor_stall');
    await expect(vis.locator('[data-train-id="T1"]')).toHaveAttribute('data-battery', '0.1');

    client.end();
  });
});
