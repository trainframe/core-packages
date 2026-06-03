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
 * Station dwell journey. Trains approaching a `station_stop` marker should
 * visibly pause there because the simulator-ui auto-spawns a withholding
 * gate at every station marker and cycles it. We can't pin the exact
 * timing — the gate cycles asynchronously — so we just assert the train
 * stalls (data-on-edge / data-at-marker don't change) for at least a
 * couple consecutive polls within the test window.
 *
 * Per ADR-013: spawning the train (physical action) is on the simulator-ui;
 * assigning the schedule (operator system intent) is on the visualiser's
 * ScheduleAssigner.
 */

const STATION_LOOP: Layout = {
  name: 'station-dwell',
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
  .serial('Trains visibly dwell at a station_stop marker', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: STATION_LOOP, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('the train stalls at least twice in a row at some point along the route', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, { layout: STATION_LOOP });

      await expect(visualiser.locator('[data-marker-id="M3"]')).toBeVisible();

      // Spawn the train at M1 (physical action on the sim-ui).
      await spawnTrain(sim, { trainId: 'T1', startMarker: 'M1' });

      // Assign a schedule via the visualiser's ScheduleAssigner.
      // assignSchedule waits for the panel to appear — it becomes visible
      // once the retained device_registered state reaches the visualiser.
      // The cyclic schedule M1→M3→M1→... causes the planner to find
      // M1→M2→M3 then M3→M4→M1, so the train visits M3 on every lap.
      await assignSchedule(visualiser, { trainId: 'T1', stops: ['M1', 'M3'] });

      // Wait for the train icon to appear (driven by marker_traversed events).
      await expect(visualiser.locator('[data-train-id="T1"]')).toBeVisible({ timeout: 8_000 });

      // Poll the train's position every 500ms for up to 20s. Each tick we
      // capture (data-on-edge, data-at-marker) — a "stall" is two consecutive
      // ticks with identical position. We require at least one stall in the
      // window. The auto-spawned station gate at M3 makes this happen.
      let consecutiveSame = 1;
      let lastPos = '';
      let maxConsecutive = 1;
      const start = Date.now();
      const POLL_MS = 500;
      const WINDOW_MS = 20_000;
      while (Date.now() - start < WINDOW_MS) {
        const el = visualiser.locator('[data-train-id="T1"]');
        const onEdge = (await el.getAttribute('data-on-edge')) ?? '';
        const atMarker = (await el.getAttribute('data-at-marker')) ?? '';
        const pos = `${onEdge}|${atMarker}`;
        if (pos === lastPos && pos !== '|') {
          consecutiveSame += 1;
          maxConsecutive = Math.max(maxConsecutive, consecutiveSame);
        } else {
          consecutiveSame = 1;
        }
        if (maxConsecutive >= 2) break;
        lastPos = pos;
        await sim.waitForTimeout(POLL_MS);
      }

      expect(maxConsecutive).toBeGreaterThanOrEqual(2);
    });
  });
