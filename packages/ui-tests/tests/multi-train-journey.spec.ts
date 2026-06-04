import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import {
  assignSchedule,
  openVisualiser,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey: spawn several trains, run the sim, watch the visualiser.
 *
 * Written from the user's POV — every assertion is something the operator can
 * see on screen. Encodes the regression for the block exclusivity release
 * (cleared edges must be pruned as a train traverses, otherwise following
 * trains sit at M1 forever).
 *
 * Trains are spawned via the Node-bridged Simulation (device-only mode) which
 * routes `device_registered` + `tag_observed` events to the harness server's
 * scheduler. Schedule assignment is on the visualiser's ScheduleAssigner
 * (operator system intent, per ADR-013).
 */

const SIMPLE_LOOP: Layout = {
  name: 'multi-train-journey',
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
  .serial('Multi-train operator journey', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: SIMPLE_LOOP, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('three trains spawned in succession all advance past the start', async ({ browser }) => {
      const visualiser = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();
      await waitForVisualiserConnected(visualiser);

      // Spawn three trains via the bridged simulation. Each spawn emits
      // device_registered to the harness server's scheduler.
      for (const id of ['T1', 'T2', 'T3']) {
        harness.simulation.spawnTrain(id, {
          startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
        });
      }

      // Assign a schedule to each train via the visualiser's ScheduleAssigner
      // (operator system intent). assignSchedule waits for the panel to
      // appear after each train's device_registered retained state lands.
      // Stops M1 and M3 route each train through M2.
      for (const id of ['T1', 'T2', 'T3']) {
        await assignSchedule(visualiser, { trainId: id, stops: ['M1', 'M3'] });
      }

      // All three trains must appear on the visualiser canvas once they
      // start moving (driven by marker_traversed / train_status events).
      // Each `expect.poll` browser round-trip takes ~hundreds of ms, so the
      // sim has to advance independently of the poll cadence — otherwise
      // 200 ms of sim time per real second isn't enough to clear three trains
      // through one block in the test budget.
      const pumpHandle = setInterval(() => harness.advance(50), 20);
      try {
        for (const id of ['T1', 'T2', 'T3']) {
          await expect
            .poll(async () => visualiser.locator(`[data-train-id="${id}"]`).count(), {
              timeout: 15_000,
              message: `expected ${id} to surface on the visualiser canvas`,
            })
            .toBeGreaterThan(0);
        }

        // Block-exclusivity regression: every train must eventually leave the
        // first edge (M1→M2). In the buggy world T1 advances and T2/T3 sit on
        // M1→M2 forever because T1 never releases the block. In the fixed world
        // T2 and T3 queue behind T1 and all three end up on later edges.
        await expect
          .poll(
            async () => {
              const positions = await visualiser
                .locator('[data-train-id]')
                .evaluateAll((els) =>
                  els.map(
                    (el) => el.getAttribute('data-at-marker') ?? el.getAttribute('data-on-edge'),
                  ),
                );
              return positions.length === 3 && positions.every((p) => p !== null && p !== 'M1->M2');
            },
            {
              timeout: 15_000,
              message: 'expected every train to leave the first edge (M1→M2)',
            },
          )
          .toBe(true);
      } finally {
        clearInterval(pumpHandle);
      }
    });
  });
