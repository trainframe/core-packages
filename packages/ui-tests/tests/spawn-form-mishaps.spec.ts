import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Type-in-form to event-out-of-broker closure. The operator dials the
 * spawn form's overshoot rate to its max, spawns a train (Spawn auto-
 * starts AND auto-resumes the sim), and watches the visualiser's live
 * event log for an `anomaly` describing the overshoot. Exercises:
 *
 *   simulator-ui form → SimRunner.spawnTrain → VirtualTrain config →
 *     overshoot detection in the sim core → anomaly event onto the broker
 *     → visualiser EventLog row
 *
 * If any link breaks, the assertion times out.
 */

const TIGHT_LOOP: Layout = {
  name: 'spawn-form-mishaps',
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
  .serial('Operator cranks the overshoot knob and sees an anomaly on the log', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: TIGHT_LOOP, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('overshoot rate=1 produces an anomaly entry mentioning overshoot', async ({ browser }) => {
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, { layout: TIGHT_LOOP });

      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();

      // Crank overshoot to its max (the input is clamped 0..1) so every
      // edge crossing the train approaches will mishap.
      await sim.getByLabel(/^Train ID/i).fill('T1');
      await sim.getByLabel(/Overshoot rate/i).fill('1');
      // Spawn auto-starts and auto-resumes the sim — no extra Resume click.
      await sim.getByRole('button', { name: /Spawn train/i }).click();

      await expect(visualiser.locator('[data-train-id="T1"]')).toBeVisible({ timeout: 8_000 });

      // The EventLog's <ol> contains one <li> per event; the strong tag
      // is the event_type, the <pre> contains the JSON payload. We assert
      // by reading the log section's text — the entry's "anomaly" tag and
      // the "overshot" description should both be present together.
      const eventLog = visualiser.getByRole('region', { name: /Event log/i });
      await expect
        .poll(
          async () => {
            const text = (await eventLog.textContent()) ?? '';
            return text.includes('anomaly') && /overshot/i.test(text);
          },
          {
            timeout: 15_000,
            message: 'expected an anomaly entry mentioning overshoot to appear in the event log',
          },
        )
        .toBe(true);
    });
  });
