import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from '@trainframe/server';
import {
  assignSchedule,
  openVisualiser,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Station dwell journey. Trains approaching a `station_stop` marker should
 * visibly pause there because a gate device is withholding clearance at that
 * marker and cycling (hold → release) on a timer.
 *
 * We spawn an explicit withholding gate at M3 via the Node-bridged Simulation
 * so the scheduler vetoes clearance extension past M3. We can't pin the exact
 * dwell timing — the gate cycles asynchronously — so we just assert the train
 * stalls (data-on-edge / data-at-marker don't change) for at least two
 * consecutive polls within the test window.
 *
 * Trains and gates are spawned via the harness's bridged Simulation (device-
 * only mode). Schedule assignment is on the visualiser's ScheduleAssigner
 * (operator system intent, per ADR-013).
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
    let admin: AdminHttpServer;
    let adminPort: number;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: STATION_LOOP, wsPort: 9001 });
      admin = new AdminHttpServer({ server: harness.server });
      adminPort = await admin.listen(0);
    });

    test.afterAll(async () => {
      await admin.close();
      await harness.shutdown();
    });

    test('the train stalls at least twice in a row at some point along the route', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser, { brokerUrl: harness.brokerWsUrl });

      await expect(visualiser.locator('[data-marker-id="M3"]')).toBeVisible();
      await waitForVisualiserConnected(visualiser);

      // Spawn a gate at M3 (the station marker) so the scheduler withholds
      // clearance past that point. The gate's `core.gates_clearance` capability
      // means the scheduler will consult it before extending clearance to M4.
      harness.simulation.spawnGate('GATE-M3');

      // Hold the gate at M3 so it withholds clearance. The admin API tells
      // the gate to withhold on the marker.
      const holdStatus = await visualiser.evaluate(
        async ({ port }) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/gates/GATE-M3/hold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ marker_id: 'M3', reason: 'station dwell' }),
          });
          return r.status;
        },
        { port: adminPort },
      );
      expect(holdStatus).toBe(204);

      // Spawn the train on M1→M2.
      harness.simulation.spawnTrain('T1', {
        startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      });

      // Assign a schedule via the visualiser's ScheduleAssigner.
      // The cyclic schedule M1→M3→M1→... causes the planner to find
      // M1→M2→M3 then M3→M4→M1, so the train visits M3 on every lap.
      await assignSchedule(visualiser, { trainId: 'T1', stops: ['M1', 'M3'] });

      // Wait for the train icon to appear.
      await expect
        .poll(
          async () => {
            harness.advance(200);
            return await visualiser.locator('[data-train-id="T1"]').count();
          },
          { timeout: 15_000, message: 'expected T1 to surface on the visualiser canvas' },
        )
        .toBeGreaterThan(0);

      // Poll the train's position every 500ms for up to 20s. Each tick we
      // capture (data-on-edge, data-at-marker) — a "stall" is two consecutive
      // ticks with identical position. We require at least one stall in the
      // window. The gate hold at M3 causes this.
      let consecutiveSame = 1;
      let lastPos = '';
      let maxConsecutive = 1;
      const start = Date.now();
      const POLL_MS = 500;
      const WINDOW_MS = 20_000;
      while (Date.now() - start < WINDOW_MS) {
        harness.advance(500);
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
        await visualiser.waitForTimeout(POLL_MS);
      }

      expect(maxConsecutive).toBeGreaterThanOrEqual(2);
    });
  });
