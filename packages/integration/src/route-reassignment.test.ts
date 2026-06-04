import type { Layout } from '@trainframe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * Route reassignment: a second `assignSchedule` while the train is mid-journey
 * must replace the prior plan. The scheduler publishes a fresh `assign_route`
 * command carrying the new planner-computed edges, and the old `cleared_edges`
 * are released (visible via `getTrainState`).
 *
 * Layout: a figure-eight — two branches sharing M1. The original schedule uses
 * M1→M2→M3; the replacement uses M1→M4→M5→M6, edges the train would never
 * reach under the original plan.
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

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ layout: FIGURE_EIGHT });
  await harness.testClient.seedIdentityTags(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
});

afterEach(async () => {
  await harness.shutdown();
});

const assignRouteCommandsFor = (trainId: string) =>
  harness.testClient.commandsFor(trainId).filter((c) => c.command_type === 'assign_route');

describe('Mid-journey schedule reassignment replaces the prior plan', () => {
  it('a second assignSchedule issues an assign_route for the new edges only', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    // Original schedule: stops M1 and M3. Planner resolves M1→M2→M3.
    harness.server.assignSchedule('T1', 'route-original', ['M1', 'M3']);

    // Wait for the first assign_route to arrive. Its edges must be on the
    // M2 branch only.
    await harness.testClient.waitForCommand('T1', 'assign_route');
    const firstRouteCommands = assignRouteCommandsFor('T1');
    expect(firstRouteCommands).toHaveLength(1);
    const firstEdges = (
      firstRouteCommands[0]?.payload as {
        edges: Array<{ from_marker_id: string; to_marker_id: string }>;
      }
    ).edges;
    const firstEdgeKeys = firstEdges.map((e) => `${e.from_marker_id}->${e.to_marker_id}`);
    expect(firstEdgeKeys).toContain('M1->M2');
    expect(firstEdgeKeys).toContain('M2->M3');
    // Must NOT contain the M4 branch edges
    expect(firstEdgeKeys).not.toContain('M1->M4');

    // Advance T1 past M1 so the scheduler knows it has left the start.
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M1' });

    // Replacement schedule: stops M1 and M6. Planner resolves M1→M4→M5→M6.
    harness.server.assignSchedule('T1', 'route-swap', ['M1', 'M6']);

    // A second assign_route must arrive with the new edges.
    const start = Date.now();
    while (assignRouteCommandsFor('T1').length < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const allRouteCommands = assignRouteCommandsFor('T1');
    expect(allRouteCommands.length).toBeGreaterThanOrEqual(2);

    const secondCommand = allRouteCommands[allRouteCommands.length - 1];
    const secondEdges = (
      secondCommand?.payload as { edges: Array<{ from_marker_id: string; to_marker_id: string }> }
    ).edges;
    const secondEdgeKeys = secondEdges.map((e) => `${e.from_marker_id}->${e.to_marker_id}`);
    // New route uses the M4 branch exclusively.
    expect(secondEdgeKeys).toContain('M1->M4');
    expect(secondEdgeKeys).toContain('M4->M5');
    expect(secondEdgeKeys).toContain('M5->M6');
    // Must NOT contain the old M2 branch.
    expect(secondEdgeKeys).not.toContain('M1->M2');
    expect(secondEdgeKeys).not.toContain('M2->M3');
  });

  it('reassignment releases cleared_edges from the old plan', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    // Assign original and wait for the initial clearance grant so the
    // scheduler has committed the M1→M2 edge to cleared_edges.
    harness.server.assignSchedule('T1', 'route-original', ['M1', 'M3']);
    await harness.testClient.waitForCommand('T1', 'grant_clearance');

    const stateBefore = harness.server.getScheduler().getTrainState('T1');
    expect(stateBefore?.cleared_edges.length).toBeGreaterThan(0);

    // Reassign. The scheduler must reset cleared_edges as part of plan
    // replacement.
    harness.server.assignSchedule('T1', 'route-swap', ['M1', 'M6']);

    // Wait a beat for the scheduler to process the reassignment.
    await new Promise((r) => setTimeout(r, 200));

    const stateAfter = harness.server.getScheduler().getTrainState('T1');
    // After reassignment the scheduler replans from scratch; the old cleared
    // edges from the original plan must not persist into the new transit.
    // The new plan may immediately grant clearance for the first new edge, so
    // we just check it doesn't still contain M1→M2 (the old branch).
    const oldEdgeStillHeld = stateAfter?.cleared_edges.some(
      (e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2',
    );
    expect(oldEdgeStillHeld).toBeFalsy();
  });
});
