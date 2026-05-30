import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { openSimulatorUi, openVisualiser } from '../src/playwright-helpers.js';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Layout configuration journey: the operator picks the `long-loop` preset
 * in `LayoutConfig`, applies it, hits Start so the new retained layout
 * message goes onto the broker, and watches the visualiser pick up the
 * new marker set. Then they paste referentially-invalid JSON: the form
 * surfaces an inline error and the broker is not republished, so the
 * visualiser stays on the previously-applied layout.
 *
 * The harness boots with the `simple-loop` preset's exact shape so that
 * the simulator-ui's first Start publishes onto the same topic the
 * harness already retained — the visualiser starts on simple-loop, the
 * preset swap is what introduces M5 / M6.
 */

const SIMPLE_LOOP_HARNESS: Layout = {
  // Must match the preset id so the SimRunner publishes onto
  // `railway/state/layout/simple-loop` (same topic the harness retained).
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

const INVALID_LAYOUT_JSON = JSON.stringify(
  {
    name: 'broken-refs',
    markers: [
      { id: 'A', kind: 'block_boundary' },
      { id: 'B', kind: 'block_boundary' },
    ],
    edges: [
      // Edge references a marker that doesn't exist in the markers list.
      { from_marker_id: 'A', to_marker_id: 'GHOST', estimated_length_mm: 100 },
    ],
    junctions: [],
  },
  null,
  2,
);

test.describe
  .serial('Operator swaps the simulator-ui layout', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      harness = await startUiHarness({ layout: SIMPLE_LOOP_HARNESS, wsPort: 9001 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('picking long-loop swaps the marker set; bad custom JSON keeps the previous one', async ({
      browser,
    }) => {
      const visualiser = await openVisualiser(browser);
      const sim = await openSimulatorUi(browser, { preset: 'simple-loop' });

      // Initial state: simple-loop markers visible, long-loop's extra
      // markers absent.
      await expect(visualiser.locator('[data-marker-id="M1"]')).toBeVisible();
      await expect(visualiser.locator('[data-marker-id="M4"]')).toBeVisible();
      await expect(visualiser.locator('[data-marker-id="M5"]')).toHaveCount(0);
      await expect(visualiser.locator('[data-marker-id="M6"]')).toHaveCount(0);

      // Operator picks the long-loop preset and applies it. Then Start
      // boots a fresh SimRunner against the new layout and publishes its
      // retained state to the broker.
      await sim.getByLabel(/Source/i).selectOption('long-loop');
      await sim.getByRole('button', { name: /Apply layout/i }).click();
      await sim.getByRole('button', { name: 'Start', exact: true }).click();

      await expect(visualiser.locator('[data-marker-id="M5"]')).toBeVisible({ timeout: 10_000 });
      await expect(visualiser.locator('[data-marker-id="M6"]')).toBeVisible({ timeout: 10_000 });

      // Now the operator switches to Custom JSON and submits something
      // that's schema-clean but referentially broken (edge mentions a
      // marker that doesn't exist). The form must surface an inline
      // error AND not republish anything — the visualiser stays put.
      await sim.getByLabel(/Source/i).selectOption('custom');
      const textarea = sim.getByLabel(/Layout JSON/i);
      await textarea.fill(INVALID_LAYOUT_JSON);
      await sim.getByRole('button', { name: /Apply layout/i }).click();

      await expect(sim.getByTestId('layout-error')).toBeVisible({ timeout: 2_000 });

      // The previously-applied layout is still rendered: M5 and M6 stay
      // visible, and the orphan markers from the failed JSON ("A", "B",
      // "GHOST") never appear on the canvas.
      await expect(visualiser.locator('[data-marker-id="M5"]')).toBeVisible();
      await expect(visualiser.locator('[data-marker-id="M6"]')).toBeVisible();
      await expect(visualiser.locator('[data-marker-id="GHOST"]')).toHaveCount(0);
      await expect(visualiser.locator('[data-marker-id="A"]')).toHaveCount(0);
    });
  });
