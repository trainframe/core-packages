import { expect, test } from '@playwright/test';
import {
  assignSchedule,
  openVisualiser,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, buildInterestingUiScene, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey for the schedule builder, on the real physics INTERESTING railway
 * (a winding main loop with a satellite loop that diverges off the `M-satA-jn` junction). Spawning
 * a train (physical action) goes through the Node-side physics harness; assigning
 * the stops the train cycles through (operator system intent) happens on the
 * visualiser's ScheduleAssigner. The planner computes the per-leg transit through
 * the layout graph on demand (ADR-010), throwing the satellite switch so the train
 * takes the loop. `M-satA` (the satellite's station) is reachable ONLY by diverting at
 * `M-satA-jn`, a trivial first-edge / main-only walk never reaches it, so observing the
 * train arrive there on the visualiser proves the planner took the operator's branch.
 */

test.describe
  .serial('Operator builds a schedule by picking stops', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ scene: buildInterestingUiScene(), wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('the train takes the branch the operator picked, not a hardcoded slice', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });

      await expect(visualiser.locator('[data-marker-id="M-north"]')).toBeVisible();
      await waitForVisualiserConnected(visualiser);

      // Spawn the train via the physics harness (physical action equivalent),
      // parked at the north marker, facing the circulation direction. The device emits device_registered + its home
      // marker, which reach the harness server's scheduler.
      harness.spawnTrain('T1', { atMarker: 'M-north', facing: 1 });

      // Operator assigns a schedule via the visualiser's ScheduleAssigner. Picking
      // `M-satA` (on the satellite loop) forces the planner to route through
      // `M-satA-jn` with the switch diverted, the branch a main-only walk never takes.
      await assignSchedule(visualiser, { trainId: 'T1', stops: ['M-north', 'M-satA'] });

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

      // The train must reach the satellite station, which only a diverted train can.
      const onBranch = (v: string | null): boolean => v !== null && /M-satA(?![-\w])/.test(v);
      await expect
        .poll(
          async () => {
            harness.advance(200);
            const el = visualiser.locator('[data-train-id="T1"]');
            return (
              onBranch(await el.getAttribute('data-on-edge')) ||
              onBranch(await el.getAttribute('data-at-marker'))
            );
          },
          {
            timeout: 30_000,
            message: 'expected T1 to reach the satellite station (M-satA)',
          },
        )
        .toBe(true);
    });
  });
