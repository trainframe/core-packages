/**
 * BEHAVIOUR GATE for ADR-019 topology-violation handling, driven end-to-end
 * through a real broker + real Server + real Scheduler (no mocks). The
 * TestClient plays the train: it registers, then reports markers as a device
 * would. The point this proves over the scheduler unit tests is that the HOLD
 * actually reaches the train on the wire — clearance is push, not poll, so a
 * train that had onward clearance must be sent an explicit `revoke_clearance`
 * or it keeps rolling into uncertain territory (the hazard ADR §2 rejects).
 */

import type { Layout } from '@trainframe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const SIMPLE_LOOP: Layout = {
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

/**
 * Poll `read` until it returns a defined value or the timeout elapses. Used to
 * wait for the LATEST retained-state write to round-trip the broker, where
 * `waitForState` (which returns the first present value) would race.
 */
async function waitUntil<T>(read: () => T | undefined, timeout_ms = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout_ms) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitUntil timed out');
}

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ layout: SIMPLE_LOOP });
  await harness.testClient.seedIdentityTags(['M1', 'M2', 'M3', 'M4']);
});

afterEach(async () => {
  await harness.shutdown();
});

describe('Topology violation handling through a real broker (ADR-019)', () => {
  it('holds a bounded-route train that reports an unreachable marker: it is stopped on the wire, flagged, and the region is locked', async () => {
    const tc = harness.testClient;
    await tc.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await tc.waitForState('railway/state/devices/T1');

    // Bounded route M1→M3: the train is granted clearance and pulls away.
    harness.server.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    await tc.waitForCommand('T1', 'grant_clearance');

    // The train now reports M4 — unreachable from M1 (no edge M1→M4). Under a
    // bounded route this is a topology violation.
    await tc.publishEvent('tag_observed', 'T1', { tag_id: 'M4' });

    // It is STOPPED on the wire: a revoke_clearance reaches the train.
    const stop = await tc.waitForCommand('T1', 'revoke_clearance');
    expect((stop.payload as { reason: string }).reason).toBe('unknown_topology');

    // A topology_violation event is emitted naming P (M1) and M (M4).
    await tc.waitForEvent('topology_violation', 'server');
    const violation = tc.events().find((e) => e.event_type === 'topology_violation');
    expect(violation?.payload).toMatchObject({
      train_id: 'T1',
      last_known_marker_id: 'M1',
      reported_marker_id: 'M4',
      suspected_cause: 'sensor_fault', // M4 is a known-but-non-adjacent marker
    });

    // The retained clearance state (scheduler-owned) carries the hold reason —
    // NOT the train-emitted train_status.
    const clearance = (await tc.waitForState('railway/state/clearance/T1')) as {
      block_reason?: string;
      cleared_edges?: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>;
    };
    expect(clearance.block_reason).toBe('unknown_topology');
    // The uncertain region M1→M4 is retained as occupancy (locks neighbours).
    expect(clearance.cleared_edges).toContainEqual({ from_marker_id: 'M1', to_marker_id: 'M4' });

    // No phantom edge was learned: the published layout still lacks M1→M4.
    const scheduler = harness.server.getScheduler();
    expect(scheduler.getLayout().findEdge('M1', 'M4')).toBeUndefined();
  });

  it('recovery via re-anchor lifts the hold and resumes scheduled operation without learning the phantom edge', async () => {
    const tc = harness.testClient;
    await tc.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await tc.waitForState('railway/state/devices/T1');

    harness.server.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    await tc.waitForCommand('T1', 'grant_clearance');
    await tc.publishEvent('tag_observed', 'T1', { tag_id: 'M4' }); // violation
    await tc.waitForCommand('T1', 'revoke_clearance');

    // Operator re-scans the train at a known marker (M2). The hold lifts and a
    // fresh route is planned from M2 — the train is told to run again.
    harness.server.reanchorTrain('T1', 'M2');

    // A fresh assign_route + grant reaches the train (operation resumes).
    await tc.waitForCommand('T1', 'assign_route');

    // The retained clearance state is republished WITHOUT block_reason. Poll
    // until that newest write has round-tripped the broker (the retained map
    // latches the latest payload; the cleared write may arrive a beat after the
    // assign_route command).
    const cleared = await waitUntil(() => {
      const c = tc.retained().get('railway/state/clearance/T1') as
        | { block_reason?: string }
        | undefined;
      return c !== undefined && c.block_reason === undefined ? c : undefined;
    });
    expect(cleared.block_reason).toBeUndefined();
    // The phantom edge was never learned.
    expect(harness.server.getScheduler().getLayout().findEdge('M1', 'M4')).toBeUndefined();
  });
});
