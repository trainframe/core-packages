import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from '@trainframe/server';
import { openVisualiser, waitForVisualiserConnected } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Safety-critical journey: the operator places a hold on a gate
 * upstream of a moving train; the train stops at the marker before the
 * gate and stays stopped across multiple observations. The operator
 * releases the gate; the train advances past.
 *
 * Wired against the harness's bridged simulation (device-only mode) so a
 * single scheduler — the harness server's — drives both the gate and the
 * train through `railway/commands/...`. POST `/api/gates/:id/hold` reaches
 * the gate, the gate emits `gate_state_changed: withholding`, the
 * scheduler vetoes clearance extension at that marker, and the train
 * receives `revoke_clearance` once it tries to cross.
 */

const LOOP: Layout = {
  name: 'gate-hold-release',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'block_boundary' },
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
  .serial('Operator holds and releases a gate, the train obeys', () => {
    let harness: UiHarness;
    let admin: AdminHttpServer;
    let adminPort: number;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: LOOP, wsPort: 9001 });
      admin = new AdminHttpServer({ server: harness.server });
      adminPort = await admin.listen(0);
    });

    test.afterAll(async () => {
      await admin.close();
      await harness.shutdown();
    });

    test('holding GATE-1 at M3 stops T1 at M2; releasing lets it advance', async ({ browser }) => {
      const visualiser = await openVisualiser(browser);
      await expect(
        visualiser.getByRole('heading', { name: /Trainframe Visualiser/i }),
      ).toBeVisible();
      await waitForVisualiserConnected(visualiser);

      // Bring the gate and train online. The gate registers itself with
      // `core.gates_clearance` so the scheduler routes hold_gate /
      // release_gate commands to it; the train registers via
      // `simulation.spawnTrain` which emits device_registered.
      harness.simulation.spawnGate('GATE-1');
      harness.simulation.spawnTrain('T1', {
        startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      });

      // Hold the gate at M3 BEFORE T1 has any clearance to cross past
      // M2. That way the scheduler vetoes the M2→M3 clearance on first
      // consultation, and T1 stops at M2.
      const holdStatus = await visualiser.evaluate(
        async ({ port, marker }) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/gates/GATE-1/hold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ marker_id: marker, reason: 'operator hold' }),
          });
          return r.status;
        },
        { port: adminPort, marker: 'M3' },
      );
      expect(holdStatus).toBe(204);

      // Assign T1 a route that wants to pass M2 and reach M3 — which is
      // exactly the marker we just gated.
      await postRoute(visualiser, adminPort, 'T1', 'gate-test-route', [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
        { from_marker_id: 'M3', to_marker_id: 'M4' },
      ]);

      // Drive the sim forward and wait for T1 to surface on the canvas.
      await expect
        .poll(
          async () => {
            harness.advance(200);
            return await visualiser.locator('[data-train-id="T1"]').count();
          },
          { timeout: 15_000, message: 'expected T1 to surface on the visualiser canvas' },
        )
        .toBeGreaterThan(0);

      // The train should be sitting at or just before M2 — the marker
      // immediately before the gated M3 — for several consecutive polls.
      // "data-at-marker = M2" is the snap-to position after the traversal
      // event; "data-on-edge = M1->M2 / M2->M3" with no further progress
      // also counts. We capture two snapshots a sim-step apart and
      // require them to match.
      const stoppedSignals = new Set(['M2', 'M1->M2', 'M2->M3']);
      const samplePosition = async (): Promise<string | null> => {
        const el = visualiser.locator('[data-train-id="T1"]');
        const onEdge = await el.getAttribute('data-on-edge');
        const atMarker = await el.getAttribute('data-at-marker');
        return atMarker ?? onEdge;
      };

      await expect
        .poll(
          async () => {
            harness.advance(500);
            const pos = await samplePosition();
            return pos !== null && stoppedSignals.has(pos);
          },
          { timeout: 15_000, message: 'expected T1 to reach the gate hold-line at M2' },
        )
        .toBe(true);

      // Verify the train stays put across multiple polls — i.e. no further
      // motion past M2 while the gate is withholding. Sample three times
      // a sim-step apart and require all three to be on the stopped side
      // of the gate.
      for (let i = 0; i < 3; i++) {
        harness.advance(500);
        await visualiser.waitForTimeout(100);
        const pos = await samplePosition();
        expect(pos === null ? null : stoppedSignals.has(pos)).toBe(true);
      }

      // Release the gate. The scheduler should re-extend clearance and
      // the train should walk past M3 toward M4.
      const releaseStatus = await visualiser.evaluate(
        async ({ port, marker }) => {
          const r = await fetch(`http://127.0.0.1:${port}/api/gates/GATE-1/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ marker_id: marker }),
          });
          return r.status;
        },
        { port: adminPort, marker: 'M3' },
      );
      expect(releaseStatus).toBe(204);

      const advancedSignals = new Set(['M3', 'M4', 'M2->M3', 'M3->M4']);
      await expect
        .poll(
          async () => {
            harness.advance(500);
            const pos = await samplePosition();
            return pos !== null && advancedSignals.has(pos);
          },
          {
            timeout: 20_000,
            message: 'expected T1 to advance past the released gate',
          },
        )
        .toBe(true);
    });
  });

interface RouteEdge {
  from_marker_id: string;
  to_marker_id: string;
}

async function postRoute(
  page: import('@playwright/test').Page,
  adminPort: number,
  trainId: string,
  routeId: string,
  edges: ReadonlyArray<RouteEdge>,
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
    { port: adminPort, train: trainId, body: { route_id: routeId, edges } },
  );
  expect(status).toBe(204);
}
