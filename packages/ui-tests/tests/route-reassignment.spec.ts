import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from '@trainframe/server';
import { openVisualiser, waitForVisualiserConnected } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Operator journey: assign a schedule, let the train run a marker or two,
 * then POST a brand-new schedule via the admin HTTP API. The operator sees
 * the train continue onto edges that only the new schedule covers.
 *
 * Architecture note: the simulator-UI's embedded `SimRunner` doesn't
 * subscribe to broker commands, so the admin endpoint's `assign_route`
 * never reaches the embedded train. Tests that need a single scheduler
 * driving real device feedback use the harness's bridged `Simulation`
 * (device-only mode), which routes commands back to virtual devices. The
 * harness server is then the only scheduler in play.
 *
 * The wire-level `assign_route` command the scheduler sends to the train
 * carries a planner-computed transit (edges), not the raw stop list — so
 * the train's clearance machinery is unchanged. What changed is the
 * operator-facing HTTP body shape: `stops` instead of `edges` (ADR-010).
 */

const FIGURE_EIGHT: Layout = {
  name: 'route-reassignment',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'block_boundary' },
    { id: 'M4', kind: 'block_boundary' },
    { id: 'M5', kind: 'block_boundary' },
    { id: 'M6', kind: 'block_boundary' },
  ],
  // Two branches sharing M1: original route follows M1→M2→M3, replacement
  // route diverts via M1→M4→M5→M6 — edges the train would never see on
  // the original plan.
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M1', estimated_length_mm: 200 },
    { from_marker_id: 'M1', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M5', estimated_length_mm: 200 },
    { from_marker_id: 'M5', to_marker_id: 'M6', estimated_length_mm: 200 },
    { from_marker_id: 'M6', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

test.describe
  .serial('Operator reassigns a schedule mid-journey', () => {
    let harness: UiHarness;
    let admin: AdminHttpServer;
    let adminPort: number;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: FIGURE_EIGHT, wsPort: 9001 });
      admin = new AdminHttpServer({ server: harness.server });
      adminPort = await admin.listen(0);
    });

    test.afterAll(async () => {
      await admin.close();
      await harness.shutdown();
    });

    test('a new schedule POSTed mid-journey replaces the old one', async ({ browser }) => {
      const visualiser = await openVisualiser(browser);
      await expect(
        visualiser.getByRole('heading', { name: /Trainframe Visualiser/i }),
      ).toBeVisible();
      await waitForVisualiserConnected(visualiser);

      // Spawn T1 on M1→M2 in the bridged sim. The sim's device_registered
      // emission reaches the harness server's scheduler through the
      // bridge; the visualiser sees the marker reads / status messages.
      harness.simulation.spawnTrain('T1', {
        startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      });

      // Original schedule: stops M1 and M3. Planner finds M1→M2→M3 (the
      // M2 branch), leaving M4/M5/M6 untouched.
      await postSchedule(visualiser, adminPort, 'T1', 'route-original', ['M1', 'M3']);

      // Drive the sim forward and wait for T1 to surface on the canvas.
      // The visualiser places trains only once a `marker_traversed` or
      // `train_status` event arrives — advancing here gives the train
      // time to cross M2 (and emit train_status as it moves).
      await expect
        .poll(
          async () => {
            harness.advance(200);
            return await visualiser.locator('[data-train-id="T1"]').count();
          },
          { timeout: 15_000, message: 'expected T1 to surface on the visualiser canvas' },
        )
        .toBeGreaterThan(0);

      // T1 should have moved off M1 by the time it's visible.
      await expect
        .poll(
          async () => {
            harness.advance(200);
            const el = visualiser.locator('[data-train-id="T1"]');
            const onEdge = await el.getAttribute('data-on-edge');
            const atMarker = await el.getAttribute('data-at-marker');
            return onEdge !== null || (atMarker !== null && atMarker !== 'M1');
          },
          { timeout: 10_000, message: 'expected T1 to leave M1 under the original route' },
        )
        .toBe(true);

      // Operator POSTs a replacement schedule via the admin HTTP endpoint.
      // Stops M1 and M6 cause the planner to find M1→M4→M5→M6 — edges
      // the train would never reach on the original plan.
      await postSchedule(visualiser, adminPort, 'T1', 'route-swap', ['M1', 'M6']);

      // Advance further so the new clearance has time to land and the
      // train can walk the swapped branch.
      const NEW_ROUTE_SIGNALS = new Set(['M1->M4', 'M4->M5', 'M5->M6', 'M4', 'M5', 'M6']);
      await expect
        .poll(
          async () => {
            harness.advance(200);
            const el = visualiser.locator('[data-train-id="T1"]');
            const onEdge = await el.getAttribute('data-on-edge');
            const atMarker = await el.getAttribute('data-at-marker');
            return (
              (onEdge !== null && NEW_ROUTE_SIGNALS.has(onEdge)) ||
              (atMarker !== null && NEW_ROUTE_SIGNALS.has(atMarker))
            );
          },
          {
            timeout: 20_000,
            message: 'expected T1 to reach an edge or marker exclusive to the new route',
          },
        )
        .toBe(true);
    });
  });

async function postSchedule(
  page: import('@playwright/test').Page,
  adminPort: number,
  trainId: string,
  routeId: string,
  stops: ReadonlyArray<string>,
): Promise<void> {
  const status = await page.evaluate(
    async ({ port, train, body }) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/trains/${train}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return r.status;
    },
    { port: adminPort, train: trainId, body: { route_id: routeId, stops } },
  );
  expect(status).toBe(204);
}
