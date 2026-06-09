/**
 * BEHAVIOUR GATE for the LEARNED-TIME-AWARE clearance horizon.
 *
 * The proactive horizon used to grant a FIXED `CLEARANCE_HORIZON_EDGES` (3)
 * blocks ahead regardless of how long each block takes to traverse. That gives
 * inconsistent lead *time* across a layout of mixed block sizes: three long
 * blocks are many seconds of warning; three short blocks are barely any.
 *
 * `LayoutState.getLearnedTraversalMs` accumulates a per-edge EWMA of traversal
 * time as trains run, but until now nothing read it. The scheduler now grows the
 * horizon ABOVE the 3-edge floor (up to a 6-edge ceiling) once it has learned
 * that the upcoming edges are short/fast, so the train keeps a consistent
 * lead TIME (`CLEARANCE_LEAD_TIME_MS`, 6 s) of clearance and starts clearing
 * earlier on the quick parts of the layout. Edges whose time it has NOT yet
 * learned are treated conservatively (assumed to carry a full lead time on their
 * own), so a cold layout behaves exactly like the old fixed floor.
 *
 * This test proves, through the real Server + Scheduler + Simulation +
 * in-process broker (no mocks, injected virtual clock, pristine fault profile,
 * fixed seed):
 *
 *   (a) on a COLD layout (no per-edge time learned yet) the train holds exactly
 *       the 3-edge floor of clearance ahead — the old behaviour, unchanged; and
 *   (b) after the train has lapped the (short, fast) ring enough times that the
 *       per-edge EWMA is populated, it holds STRICTLY MORE than the floor — the
 *       horizon learned to extend further because each block is quick — but
 *       never past the 6-edge over-lock ceiling.
 *
 * The single-train ring has no peer to conflict with, so nothing other than the
 * horizon logic limits how far ahead clearance reaches. The transit chosen
 * (S1 → S8, seven edges) is long enough that the HORIZON, not the transit
 * length, is the binding constraint.
 */

import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { startTestEnvironment } from './testing.js';

/**
 * An eight-marker ring of SHORT edges (120 mm). At the simulator's default
 * 100 mm/s a block takes ~1.2 s to cross, so the 3-edge floor is only ~3.6 s of
 * lead time — below `CLEARANCE_LEAD_TIME_MS` (6 s). Once the per-edge time is
 * learned, the horizon must pull more blocks forward (to ~5) to reach the
 * lead-time target.
 */
const SHORT_RING: Layout = {
  name: 'learned-horizon-ring',
  markers: [
    { id: 'S1', kind: 'block_boundary' },
    { id: 'S2', kind: 'block_boundary' },
    { id: 'S3', kind: 'block_boundary' },
    { id: 'S4', kind: 'block_boundary' },
    { id: 'S5', kind: 'block_boundary' },
    { id: 'S6', kind: 'block_boundary' },
    { id: 'S7', kind: 'block_boundary' },
    { id: 'S8', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'S1', to_marker_id: 'S2', estimated_length_mm: 120 },
    { from_marker_id: 'S2', to_marker_id: 'S3', estimated_length_mm: 120 },
    { from_marker_id: 'S3', to_marker_id: 'S4', estimated_length_mm: 120 },
    { from_marker_id: 'S4', to_marker_id: 'S5', estimated_length_mm: 120 },
    { from_marker_id: 'S5', to_marker_id: 'S6', estimated_length_mm: 120 },
    { from_marker_id: 'S6', to_marker_id: 'S7', estimated_length_mm: 120 },
    { from_marker_id: 'S7', to_marker_id: 'S8', estimated_length_mm: 120 },
    { from_marker_id: 'S8', to_marker_id: 'S1', estimated_length_mm: 120 },
  ],
  junctions: [],
};

describe('learned-time-aware clearance horizon — behaviour gate', () => {
  it('holds the 3-edge floor on a cold layout, then extends past it once edge times are learned', () => {
    const env = startTestEnvironment({ layout: SHORT_RING, seed: 7, faults: 'pristine' });

    env.spawnTrain('T1', {
      startEdge: { from_marker_id: 'S1', to_marker_id: 'S2' },
      config: { train_status_interval_ms: 100 },
    });
    /* A cyclic schedule whose leg spans almost the whole ring (S1 → S8, seven
     * edges), so the clearance horizon — not the transit length — is what caps
     * how far ahead the train clears. S1 == the spawn marker. */
    env.assignSchedule('T1', ['S1', 'S8']);

    const scheduler = env.server.getScheduler();
    const clearedAhead = (): number => scheduler.getTrainState('T1')?.cleared_edges.length ?? 0;

    /* (a) COLD: the initial proactive grant fires inside `assignSchedule`,
     * before the train has traversed a single edge, so no per-edge time is
     * learned. The horizon must sit at exactly the 3-edge floor — the same value
     * the old fixed-count horizon produced. */
    const coldAhead = clearedAhead();
    expect(coldAhead).toBe(3);

    /* (b) WARM: let the train lap the ring so every edge's EWMA is populated,
     * sampling the deepest clearance it holds at any moment. (Sampling the peak,
     * not a single instant, because the train releases blocks behind its head as
     * it moves; the peak is the true horizon depth.) */
    let warmMaxAhead = 0;
    for (let t = 0; t < 40_000; t += 50) {
      env.advance(50);
      warmMaxAhead = Math.max(warmMaxAhead, clearedAhead());
    }

    // The horizon learned the blocks are quick and pulled more clearance forward
    // to keep the lead-TIME target — strictly above the cold floor...
    expect(warmMaxAhead).toBeGreaterThan(coldAhead);
    // ...but never past the over-lock ceiling.
    expect(warmMaxAhead).toBeLessThanOrEqual(6);

    /* Sanity: the train genuinely lapped the ring multiple times, so the warm
     * reading is a real moving-train observation under learned conditions. */
    const s1Crossings = env
      .getEventsOfType('marker_traversed')
      .filter((e) => (e.payload as { marker_id?: unknown }).marker_id === 'S1').length;
    expect(s1Crossings).toBeGreaterThanOrEqual(3);

    env.shutdown();
  });

  it('does not over-lock a chaser once the leader has learned (and grown) its horizon', () => {
    /* The grown horizon could in principle let a learned-fast leader grab so
     * many blocks that a chaser starves — the exact "over-lock" risk the 3-edge
     * floor was originally chosen to avoid. The 6-edge ceiling exists to bound
     * it. Prove, through the real system under genuine contention, that two
     * trains circulating the learned-fast ring both keep making forward progress
     * and never settle into a deadlock.
     *
     * Eight markers, two trains: even at the 6-edge ceiling the leader cannot
     * lock the whole ring, so the chaser always has at least one block to take. */
    const env = startTestEnvironment({ layout: SHORT_RING, seed: 11, faults: 'pristine' });

    env.spawnTrain('T1', {
      startEdge: { from_marker_id: 'S1', to_marker_id: 'S2' },
      config: { train_status_interval_ms: 100 },
    });
    env.spawnTrain('T2', {
      startEdge: { from_marker_id: 'S5', to_marker_id: 'S6' },
      config: { train_status_interval_ms: 100 },
    });
    /* Both circulate the full ring continuously, offset by half a loop: T1
     * cycles S1 → S5 → S1 …, T2 cycles S5 → S1 → S5 …. Two stops each (a
     * single-stop schedule parks the train at its terminus). */
    env.assignSchedule('T1', ['S1', 'S5']);
    env.assignSchedule('T2', ['S5', 'S1']);

    // Warm-up so the per-edge EWMA populates and the horizon grows.
    env.advance(10_000);

    const crossingsAfter = (trainId: string, since: number): number =>
      env
        .getEventsOfType('marker_traversed')
        .filter(
          (e) => e.at_ms >= since && (e.payload as { train_id?: unknown }).train_id === trainId,
        ).length;

    const windowStart = env.simulation.clock.now();
    env.advance(40_000);

    /* Both trains kept moving through the learned, grown-horizon steady state —
     * neither starved behind the other. Continued forward progress over a long
     * window is exactly the absence of deadlock: a deadlocked pair makes zero
     * crossings from the moment the cycle forms. */
    expect(crossingsAfter('T1', windowStart)).toBeGreaterThanOrEqual(3);
    expect(crossingsAfter('T2', windowStart)).toBeGreaterThanOrEqual(3);

    env.shutdown();
  });
});
