import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Track-builder operator journey: the operator drops the pasted-JSON workflow
 * entirely and assembles a layout the way they would with a real wooden set —
 * one marker, one edge at a time. Once they hit Apply the visualiser must
 * reflect the new layout (all three new markers visible, the prior preset's
 * extra markers gone), proving the Build form produces a valid Layout the
 * rest of the app handles unchanged.
 *
 * The harness boots with the same simple-loop preset shape so the visualiser
 * has a layout to render before the operator does anything.
 */

const SIMPLE_LOOP_HARNESS: Layout = {
  name: 'simple-loop',
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
  .serial('Operator builds a layout step-by-step', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: SIMPLE_LOOP_HARNESS, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('Build mode assembles a three-marker layout the visualiser then renders', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, { preset: 'simple-loop' });

      // Initial state: simple-loop's M4 is rendered on the visualiser.
      await expect(visualiser.locator('[data-marker-id="M4"]')).toBeVisible();

      // Operator opens the Build form.
      await sim.getByLabel(/Source/i).selectOption('build');
      const builderForm = sim.getByRole('group', { name: /Track builder/i });
      await expect(builderForm).toBeVisible();

      // Layout name.
      const nameField = sim.getByLabel(/Layout name/i);
      await nameField.fill('built-by-hand');

      // Three markers — M1 block_boundary, M2 station_stop, M3 block_boundary.
      const markerIdField = sim.getByLabel(/^Marker ID/i);
      const kindField = sim.getByLabel(/^Kind/i);
      const addMarkerButton = sim.getByRole('button', { name: /Add marker/i });

      await markerIdField.fill('M1');
      await kindField.selectOption('block_boundary');
      await addMarkerButton.click();

      await markerIdField.fill('M2');
      await kindField.selectOption('station_stop');
      await addMarkerButton.click();

      await markerIdField.fill('M3');
      await kindField.selectOption('block_boundary');
      await addMarkerButton.click();

      // Edges M1->M2, M2->M3.
      const fromField = sim.getByLabel(/^From marker/i);
      const toField = sim.getByLabel(/^To marker/i);
      const addEdgeButton = sim.getByRole('button', { name: /Add edge/i });

      await fromField.selectOption('M1');
      await toField.selectOption('M2');
      await addEdgeButton.click();

      await fromField.selectOption('M2');
      await toField.selectOption('M3');
      await addEdgeButton.click();

      // Apply.
      await sim.getByRole('button', { name: /Apply layout/i }).click();

      // The visualiser flips to the new layout: M1/M2/M3 are visible, the
      // previous preset's M4 marker is gone.
      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible({ timeout: 10_000 });
      await expect(visualiser.locator('[data-marker-id="M2"]')).toBeVisible({ timeout: 10_000 });
      await expect(visualiser.locator('[data-marker-id="M3"]')).toBeVisible({ timeout: 10_000 });
      await expect(visualiser.locator('[data-marker-id="M4"]')).toHaveCount(0);

      // Close the contexts so their broker WebSocket connections drop now,
      // not whenever Playwright eventually GCs them. Without this the next
      // describe's harness shutdown can race with these stale connections
      // and leave the following spec's visualiser stuck in `Disconnected`.
      await sim.context().close();
      await visualiser.context().close();
    });
  });
