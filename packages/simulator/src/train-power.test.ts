/**
 * BEHAVIOUR GATE for the train POWER model (inert-in-place, not despawn).
 *
 * Powering a train OFF must NOT remove it from the network the way a despawn
 * does. The correct model, exercised here through the real
 * Server + Scheduler + Simulation + in-process broker (no mocks, injected
 * virtual clock, pristine fault profile, fixed seed):
 *
 *   (a) a running train, powered off, STAYS in the simulation at its current
 *       position (it is not despawned and not moved);
 *   (b) it goes SILENT — it emits no further events of its own, and crucially
 *       NO `device_disconnected` (a dead train doesn't announce its departure);
 *   (c) because the server hears silence (not a disconnect) it keeps the train's
 *       last state and HOLDS its block reserved — a following train closing up
 *       behind it is NOT cleared past it (the line is fouled but safe): the
 *       follower stalls and stays stalled;
 *   (d) powering the train back ON resumes it — it drives on and crosses the
 *       next marker, and the follower is subsequently released too.
 *
 * No scheduler/core change is needed for the block hold: the scheduler releases
 * a block only on `device_disconnected` (handleDeviceDisconnect), and a silent
 * train triggers none. Verified: the only time-based release in the scheduler
 * is station dwell, which is observed via `train_status` from a *parked* train —
 * a powered-off train emits no status, so even dwell never fires for it.
 */

import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { startTestEnvironment } from './testing.js';

/** An eight-marker ring of plain block boundaries (no station dwell), long
 * enough that the leader can hold its edge plus a clearance horizon while the
 * follower still has room to move up and then stall behind it. */
const RING: Layout = {
  name: 'power-ring',
  markers: [
    { id: 'P1', kind: 'block_boundary' },
    { id: 'P2', kind: 'block_boundary' },
    { id: 'P3', kind: 'block_boundary' },
    { id: 'P4', kind: 'block_boundary' },
    { id: 'P5', kind: 'block_boundary' },
    { id: 'P6', kind: 'block_boundary' },
    { id: 'P7', kind: 'block_boundary' },
    { id: 'P8', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'P1', to_marker_id: 'P2', estimated_length_mm: 300 },
    { from_marker_id: 'P2', to_marker_id: 'P3', estimated_length_mm: 300 },
    { from_marker_id: 'P3', to_marker_id: 'P4', estimated_length_mm: 300 },
    { from_marker_id: 'P4', to_marker_id: 'P5', estimated_length_mm: 300 },
    { from_marker_id: 'P5', to_marker_id: 'P6', estimated_length_mm: 300 },
    { from_marker_id: 'P6', to_marker_id: 'P7', estimated_length_mm: 300 },
    { from_marker_id: 'P7', to_marker_id: 'P8', estimated_length_mm: 300 },
    { from_marker_id: 'P8', to_marker_id: 'P1', estimated_length_mm: 300 },
  ],
  junctions: [],
};

function markerTraversals(env: ReturnType<typeof startTestEnvironment>, trainId: string): number {
  return env
    .getEventsOfType('marker_traversed')
    .filter((e) => (e.payload as { train_id?: unknown }).train_id === trainId).length;
}

describe('train power model — inert-in-place, block held on silence', () => {
  it('power-off keeps the train in the sim, silent, holds its block; power-on resumes', () => {
    const env = startTestEnvironment({ layout: RING, seed: 7, faults: 'pristine', tick_ms: 50 });

    // --- Stage the leader (A) a few markers into the loop, alone first, so
    // there is no ambiguity about which train leads. ---
    env.spawnTrain('A', {
      startEdge: { from_marker_id: 'P1', to_marker_id: 'P2' },
      config: { train_status_interval_ms: 100 },
    });
    env.assignSchedule('A', ['P1', 'P8']); // long cyclic loop, no intermediate stop
    env.advance(8_000);

    const simA = env.simulation.getTrain('A');
    expect(simA).toBeDefined();
    if (simA === undefined) throw new Error('unreachable');

    // --- Mid-transit precondition: A is genuinely moving on an edge, not
    // parked at a marker. Powering off a parked train would prove nothing. ---
    const edgeA = simA.getCurrentEdge();
    expect(edgeA).not.toBeNull();
    if (edgeA === null) throw new Error('unreachable');
    expect(simA.getVelocity()).toBeGreaterThan(0);
    const aEdgeLength =
      env.simulation.layout.findEdge(edgeA.from_marker_id, edgeA.to_marker_id)
        ?.estimated_length_mm ?? 0;
    expect(simA.getDistanceIntoEdge()).toBeGreaterThan(0);
    expect(simA.getDistanceIntoEdge()).toBeLessThan(aEdgeLength);

    // --- Bring the follower (B) up behind A on the same loop. ---
    env.spawnTrain('B', {
      startEdge: { from_marker_id: 'P1', to_marker_id: 'P2' },
      config: { train_status_interval_ms: 100 },
    });
    env.assignSchedule('B', ['P1', 'P8']);

    // === POWER OFF A, mid-transit. ===
    const aEventsBefore = env.events.filter((e) => e.device_id === 'A').length;
    const aEdgeAtOff = simA.getCurrentEdge();
    const aDistAtOff = simA.getDistanceIntoEdge();
    env.simulation.setTrainPowered('A', false);

    // Let B drive up behind A and close the gap.
    env.advance(20_000);

    // (a) A is still in the sim, at its frozen position (not despawned/moved).
    expect(env.simulation.getTrain('A')).toBe(simA);
    expect(simA.isPowered()).toBe(false);
    expect(simA.getVelocity()).toBe(0);
    expect(simA.getCurrentEdge()).toEqual(aEdgeAtOff);
    expect(simA.getDistanceIntoEdge()).toBe(aDistAtOff);

    // (b) A went silent: it emitted nothing further of its own, and NO
    // `device_disconnected` was ever published for A.
    const aEventsAfter = env.events.filter((e) => e.device_id === 'A').length;
    expect(aEventsAfter).toBe(aEventsBefore);
    expect(
      env.events.filter((e) => e.event_type === 'device_disconnected' && e.device_id === 'A')
        .length,
    ).toBe(0);

    // (c) B is held behind A: the block A occupies stays reserved. Capture B's
    // position, advance further, and assert it does not move — fouled but safe,
    // not merely slow or still approaching.
    const bSim = env.simulation.getTrain('B');
    expect(bSim).toBeDefined();
    if (bSim === undefined) throw new Error('unreachable');
    const bEdgeStalled = bSim.getCurrentEdge();
    const bDistStalled = bSim.getDistanceIntoEdge();
    const bTraversalsStalled = markerTraversals(env, 'B');
    env.advance(15_000);
    expect(bSim.getVelocity()).toBe(0);
    expect(bSim.getCurrentEdge()).toEqual(bEdgeStalled);
    expect(bSim.getDistanceIntoEdge()).toBe(bDistStalled);
    // B never traversed onto the marker/edge A is sitting on.
    expect(markerTraversals(env, 'B')).toBe(bTraversalsStalled);
    // Still no disconnect for A across the whole hold.
    expect(
      env.events.filter((e) => e.event_type === 'device_disconnected' && e.device_id === 'A')
        .length,
    ).toBe(0);

    // (d) POWER A BACK ON — it resumes driving and crosses its next marker,
    // and the follower B is subsequently released too.
    const aTraversalsBeforeResume = markerTraversals(env, 'A');
    env.simulation.setTrainPowered('A', true);
    expect(simA.isPowered()).toBe(true);
    env.advance(20_000);
    expect(markerTraversals(env, 'A')).toBeGreaterThan(aTraversalsBeforeResume);
    // B gets going again once A vacates the block.
    expect(markerTraversals(env, 'B')).toBeGreaterThan(bTraversalsStalled);

    env.shutdown();
  });
});
