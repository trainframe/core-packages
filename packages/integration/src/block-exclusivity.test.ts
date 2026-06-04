import type { Layout } from '@trainframe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * Block exclusivity: when several trains share a single-block layout, only one
 * train may hold a cleared edge at a time. A follower's `grant_clearance` must
 * not arrive until the leader has reported passing the edge boundary
 * (`tag_observed`), which causes the scheduler to release the block.
 *
 * Regression: cleared edges were not pruned on traversal, so following trains
 * sat at M1 forever waiting for a grant that was blocked by stale `cleared_edges`
 * entries that should have been removed when T1 crossed M2.
 */

const SIMPLE_LOOP: Layout = {
  name: 'block-exclusivity',
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

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ layout: SIMPLE_LOOP });
  await harness.testClient.seedIdentityTags(['M1', 'M2', 'M3', 'M4']);
});

afterEach(async () => {
  await harness.shutdown();
});

const grantsFor = (trainId: string) =>
  harness.testClient.commandsFor(trainId).filter((c) => c.command_type === 'grant_clearance');

describe('Block exclusivity: three trains queue through a single block', () => {
  it('T2 and T3 receive no clearance until T1 clears the entire M1→M2→M3 block chain', async () => {
    // Register all three trains in sequence. Each emits device_registered and
    // waits for the retained device state before proceeding.
    for (const id of ['T1', 'T2', 'T3']) {
      await harness.testClient.publishEvent('device_registered', id, {
        capabilities: ['core.controls_motion', 'core.accepts_route'],
      });
      await harness.testClient.waitForState(`railway/state/devices/${id}`);
    }

    // Assign each train the same cyclic route: stops M1 and M3, which routes
    // them through the M1→M2→M3 block. All three arrive at the scheduler before
    // any of them have emitted a tag_observed, so they start from M1.
    for (const id of ['T1', 'T2', 'T3']) {
      harness.server.assignSchedule(id, 'route-loop', ['M1', 'M3']);
    }

    // T1 is first and gets the initial M2 clearance.
    await harness.testClient.waitForCommand('T1', 'grant_clearance');
    const t1FirstGrant = grantsFor('T1')[0];
    expect((t1FirstGrant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');

    // T2 and T3 must NOT have received any clearance yet — the block is held by T1.
    await new Promise((r) => setTimeout(r, 200));
    expect(grantsFor('T2')).toHaveLength(0);
    expect(grantsFor('T3')).toHaveLength(0);

    // T1 walks M1→M2→M3. The section-pair rule (ADR-011) means T2 can only
    // enter M1→M2 once T1's M2→M3 clearance is also released, which happens
    // when T1 crosses M3 (its clearance limit at the time).
    // Walk: M1 → M2 (T1 gets extended clearance to M3) → M3 (T1 releases M2→M3).
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M1' });
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M2' });
    // At this point T1 holds M2→M3; T2 is still blocked by the shared M2 boundary.
    await new Promise((r) => setTimeout(r, 200));
    expect(grantsFor('T2')).toHaveLength(0);

    // T1 crosses M3: M2→M3 is released. The section-pair check passes for T2.
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M3' });

    // After T1 releases M2→M3 at M3, T2 — the next queued train — gets clearance.
    await harness.testClient.waitForCommand('T2', 'grant_clearance', 2000);
    const t2Grants = grantsFor('T2');
    expect(t2Grants.length).toBeGreaterThanOrEqual(1);
    expect((t2Grants[0]?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');

    // T3 still has no clearance — the block is now held by T2.
    expect(grantsFor('T3')).toHaveLength(0);

    // T2 walks M1→M2→M3 to release its block.
    await harness.testClient.publishEvent('tag_observed', 'T2', { tag_id: 'M1' });
    await harness.testClient.publishEvent('tag_observed', 'T2', { tag_id: 'M2' });
    await harness.testClient.publishEvent('tag_observed', 'T2', { tag_id: 'M3' });

    // T3 now receives its clearance.
    await harness.testClient.waitForCommand('T3', 'grant_clearance', 2000);
    const t3Grants = grantsFor('T3');
    expect(t3Grants.length).toBeGreaterThanOrEqual(1);
    expect((t3Grants[0]?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');
  });
});
