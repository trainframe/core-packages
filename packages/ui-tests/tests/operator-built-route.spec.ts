import { expect, test } from '@playwright/test';
import {
  assignSchedule,
  openVisualiser,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, buildBranchingUiScene, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey for the schedule builder, on the real physics BRANCHING scene
 * (main ring + a scenic BRANCH that diverges off the `M-spur` junction). Spawning
 * a train (physical action) goes through the Node-side physics harness; assigning
 * the stops the train cycles through (operator system intent) happens on the
 * visualiser's ScheduleAssigner. The planner computes the per-leg transit through
 * the layout graph on demand (ADR-010), throwing the `Jspur` switch so the train
 * climbs the branch. `M-branch-top` is reachable ONLY by diverting at `M-spur` —
 * a trivial first-edge / main-only walk never reaches it — so observing the train
 * arrive there on the visualiser proves the planner took the operator's branch.
 */

test.describe
  .serial('Operator builds a schedule by picking stops', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ scene: buildBranchingUiScene(), wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('the train takes the branch the operator picked, not a hardcoded slice', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });

      await expect(visualiser.locator('[data-marker-id="M-main-e"]')).toBeVisible();
      await waitForVisualiserConnected(visualiser);

      // Spawn the train via the physics harness (physical action equivalent),
      // parked on the ascending right straight just before the spur, facing the
      // circulation direction. The device emits device_registered + its home
      // marker, which reach the harness server's scheduler.
      harness.spawnTrain('T1', { atMarker: 'M-main-e', facing: 1 });

      // Operator assigns a schedule via the visualiser's ScheduleAssigner. Picking
      // `M-branch-top` (on the scenic branch) forces the planner to route through
      // `M-spur` with the switch diverted — the branch a main-only walk never takes.
      await assignSchedule(visualiser, { trainId: 'T1', stops: ['M-main-e', 'M-branch-top'] });

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

      // The train must reach a marker/edge exclusive to the scenic branch
      // (`M-branch-top` / `M-branch-bot`) — only reachable by diverting at the spur.
      const onBranch = (v: string | null): boolean =>
        v !== null && (v.includes('M-branch-top') || v.includes('M-branch-bot'));
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
            message: 'expected T1 to reach the scenic branch (M-branch-top / M-branch-bot)',
          },
        )
        .toBe(true);
    });
  });
