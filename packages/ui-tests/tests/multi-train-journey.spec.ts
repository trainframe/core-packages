import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import {
  assignSchedule,
  openSimulatorUi,
  openVisualiser,
  spawnTrain,
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
 * Per ADR-013: spawning is on the sim-ui (physical action); schedule
 * assignment is on the visualiser's ScheduleAssigner (operator system intent).
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
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, { layout: SIMPLE_LOOP });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();

      // Operator places trains on the track via the sim-ui (physical action).
      // The spawn-position auto-selects M1; Train ID is filled explicitly for
      // determinism. Each Spawn auto-starts and auto-resumes the sim.
      for (const id of ['T1', 'T2', 'T3']) {
        await spawnTrain(sim, { trainId: id, startMarker: 'M1' });
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
      for (const id of ['T1', 'T2', 'T3']) {
        await expect(visualiser.locator(`[data-train-id="${id}"]`)).toBeVisible({ timeout: 8_000 });
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
    });
  });
