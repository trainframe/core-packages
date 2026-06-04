import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import {
  assignSchedule,
  openVisualiser,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey for the schedule builder. Spawning a train (physical
 * action) is performed via the Node-bridged Simulation; assigning the stops
 * the train will cycle through (operator system intent) happens on the
 * visualiser's ScheduleAssigner. The planner computes the per-leg transit
 * through the layout graph on demand (ADR-010). We assert the train visits
 * the branch the operator selected by watching the visualiser as edges advance.
 */

const BRANCHED: Layout = {
  name: 'operator-built-route',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'block_boundary' },
    { id: 'M4', kind: 'block_boundary' },
    { id: 'M5', kind: 'block_boundary' },
  ],
  // Two branches sharing M2: M1→M2→M3→M4→M1 and M1→M2→M5→M1. The operator
  // picks M5 as a stop so the planner routes M1→M2→M5, exercising the branch
  // that a trivial first-edge walk would never take. Both branches loop back
  // to M1 so cyclic schedules can resolve their return leg.
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M5', estimated_length_mm: 200 },
    { from_marker_id: 'M5', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

test.describe
  .serial('Operator builds a schedule by picking stops', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: BRANCHED, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('the train takes the branch the operator picked, not a hardcoded slice', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();
      await waitForVisualiserConnected(visualiser);

      // Spawn the train via the bridged Node simulation (physical action
      // equivalent). The bridge emits device_registered + tag_observed events
      // that reach the harness server's scheduler.
      harness.simulation.spawnTrain('T1', {
        startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      });

      // Operator assigns a schedule via the visualiser's ScheduleAssigner.
      // assignSchedule waits for the panel to appear — it becomes visible
      // once the retained device_registered state reaches the visualiser.
      // Stops M1 and M5 cause the planner to find M1→M2→M5, exercising the
      // branch that a trivial first-edge walk would never take.
      await assignSchedule(visualiser, { trainId: 'T1', stops: ['M1', 'M5'] });

      // Confirm the assigner shows the sent confirmation.
      await expect(visualiser.getByTestId('schedule-assigner-sent')).toBeVisible();

      // Now that the train has a schedule it starts moving. Wait for its
      // icon to appear (driven by marker_traversed / train_status events).
      await expect
        .poll(
          async () => {
            harness.advance(200);
            return await visualiser.locator('[data-train-id="T1"]').count();
          },
          { timeout: 15_000, message: 'expected T1 to surface on the visualiser canvas' },
        )
        .toBeGreaterThan(0);

      // The branch from M2 has M5 as its destination — the train must reach
      // an edge or marker exclusive to that branch within the test window.
      const ON_BRANCH = new Set(['M2->M5', 'M5']);
      await expect
        .poll(
          async () => {
            harness.advance(200);
            const el = visualiser.locator('[data-train-id="T1"]');
            const onEdge = await el.getAttribute('data-on-edge');
            const atMarker = await el.getAttribute('data-at-marker');
            return (
              (onEdge !== null && ON_BRANCH.has(onEdge)) ||
              (atMarker !== null && ON_BRANCH.has(atMarker))
            );
          },
          {
            timeout: 20_000,
            message: 'expected T1 to reach an edge/marker exclusive to the M2→M5 branch',
          },
        )
        .toBe(true);

      // Conversely the train must NOT have ended up on the M3/M4 branch.
      const onEdge = await visualiser.locator('[data-train-id="T1"]').getAttribute('data-on-edge');
      const atMarker = await visualiser
        .locator('[data-train-id="T1"]')
        .getAttribute('data-at-marker');
      const positionalChecks = [onEdge, atMarker].filter((v): v is string => v !== null);
      for (const p of positionalChecks) {
        expect(['M2->M3', 'M3->M4', 'M3', 'M4']).not.toContain(p);
      }
    });
  });
