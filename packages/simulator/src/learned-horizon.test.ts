/**
 * BEHAVIOUR GATE for the LEARNED-TIME-AWARE clearance horizon.
 *
 * The proactive horizon used to grant a FIXED `CLEARANCE_HORIZON_EDGES` (3) blocks
 * ahead regardless of how long each block takes to traverse. That gives inconsistent
 * lead *time* across a layout of mixed block sizes: three long blocks are many seconds
 * of warning; three short blocks are barely any.
 *
 * `LayoutState.getLearnedTraversalMs` accumulates a per-edge EWMA of traversal time as
 * trains run. The scheduler grows the horizon ABOVE the 3-edge floor (up to a 6-edge
 * ceiling) once it has learned that the upcoming edges are short/fast, so the train
 * keeps a consistent lead TIME (`CLEARANCE_LEAD_TIME_MS`, 6 s) of clearance. Edges
 * whose time it has NOT yet learned are treated conservatively, so a cold layout
 * behaves exactly like the old fixed floor.
 *
 * This test proves the same end-to-end, through the REAL `@trainframe/server`
 * scheduler + REAL physics `ScheduledTrainDevice` on a REAL `PhysicsWorld`, driven
 * synchronously over the in-memory broker (no mocks). The horizon depth is read the
 * way the gate tests read clearance — off the `grant_clearance` commands the scheduler
 * issues to the train (`limit_marker_id`), never from scheduler internals:
 *
 *   (a) on a COLD layout (no per-edge time learned yet) the proactive grant clears
 *       exactly the 3-edge floor ahead — the old behaviour, unchanged; and
 *   (b) after the train has lapped the (short, fast) ring enough times that the
 *       per-edge EWMA is populated, a fresh assignment clears STRICTLY MORE than the
 *       floor — the horizon learned to extend further because each block is quick —
 *       but never past the 6-edge over-lock ceiling.
 *
 * The single-train ring has no peer to conflict with, so nothing other than the
 * horizon logic limits how far ahead clearance reaches. The leg chosen (seven edges
 * the long way round) is longer than the ceiling, so the HORIZON, not the leg length,
 * is the binding constraint.
 */

import {
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * An eight-marker ring of SHORT edges (120 mm). The physics loco tops out at
 * 400 mm/s, so a block takes well under a second to cross — the 3-edge floor is only a
 * couple of seconds of lead time, below `CLEARANCE_LEAD_TIME_MS` (6 s). Once the
 * per-edge time is learned, the horizon must pull more blocks forward to reach the
 * lead-time target. Eight markers means a single leg can run seven edges — past the
 * six-edge ceiling — so the ceiling, not the leg, caps the grown horizon.
 */
const RING_MARKER_IDS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'] as const;

const buildScene = () =>
  straightLoop(
    RING_MARKER_IDS.map((id) => ({ id, kind: 'block_boundary' as const })),
    { spacingMm: 120, name: 'learned-horizon-ring' },
  );

let env: PhysicsEnv;

afterEach(() => {
  env.shutdown();
});

/** The marker IDs cleared, in order, by the train's `grant_clearance` commands. */
const grantLimits = (): string[] =>
  env
    .commandsFor('T1')
    .filter((c) => c.command_type === 'grant_clearance')
    .map((c) => String(c.payload.limit_marker_id));

/** How many times `trainId` has crossed `markerId`, as a moving-train sanity check. */
const crossings = (trainId: string, markerId: string): number =>
  env
    .eventsOfType('marker_traversed')
    .filter(
      (e) =>
        (e.payload as { train_id?: unknown }).train_id === trainId &&
        (e.payload as { marker_id?: unknown }).marker_id === markerId,
    ).length;

describe('learned-time-aware clearance horizon — behaviour gate', () => {
  it('clears the 3-edge floor on a cold layout, then extends past it once edge times are learned', () => {
    env = startPhysicsEnv(buildScene());

    env.spawnTrain('T1', { atMarker: 'S1' });
    /* A leg that spans almost the whole ring (S1 → S8, seven edges), so the clearance
     * horizon — not the leg length — caps how far ahead the train is cleared. */
    env.assignSchedule('T1', ['S1', 'S8']);

    /* (a) COLD: the proactive grant fires inside `assignSchedule`, before the train
     * has traversed a single edge, so no per-edge time is learned. The scheduler
     * clears exactly the 3-edge floor ahead — limits S2, S3, S4 — the same depth the
     * old fixed-count horizon produced. */
    const coldLimits = grantLimits();
    expect(coldLimits).toEqual(['S2', 'S3', 'S4']);
    const coldHorizon = coldLimits.length;

    /* (b) WARM: let the train lap the ring so every edge's EWMA is populated with its
     * short, fast traversal time. */
    for (let t = 0; t < 40_000; t += 500) {
      env.advance(500);
    }

    /* The train genuinely lapped the ring multiple times, so the learned times are
     * real moving-train observations. */
    expect(crossings('T1', 'S1')).toBeGreaterThanOrEqual(3);

    /* Re-assign a fresh seven-edge leg from wherever the train now sits. The new
     * proactive grant reads the learned (fast) edge times and must pull MORE than the
     * cold floor forward to hold the 6 s lead time — capped by the six-edge ceiling.
     * The cold assignment above cleared exactly three under the identical leg shape;
     * the only difference now is the learned timings. */
    const lastMarker = String(
      (env.eventsOfType('marker_traversed').at(-1)?.payload as { marker_id?: unknown }).marker_id,
    );
    const fromIdx = RING_MARKER_IDS.indexOf(lastMarker as (typeof RING_MARKER_IDS)[number]);
    /* Seven edges the long way round: turn-marker is the one immediately *behind* the
     * current marker on the ring, so the leg traverses every other marker first. */
    const toMarker =
      RING_MARKER_IDS[(fromIdx + RING_MARKER_IDS.length - 1) % RING_MARKER_IDS.length];
    expect(toMarker).toBeDefined();

    const grantsBeforeReassign = grantLimits().length;
    env.assignSchedule('T1', [lastMarker, toMarker ?? lastMarker]);
    const warmHorizon = grantLimits().length - grantsBeforeReassign;

    /* The horizon learned the blocks are quick and pulled more clearance forward to
     * keep the lead-TIME target — strictly above the cold floor... */
    expect(warmHorizon).toBeGreaterThan(coldHorizon);
    /* ...but never past the over-lock ceiling. */
    expect(warmHorizon).toBeLessThanOrEqual(6);
  });

  it('does not over-lock a chaser once the leader has learned (and grown) its horizon', () => {
    /* The grown horizon could in principle let a learned-fast leader grab so many
     * blocks that a chaser starves — the exact "over-lock" risk the 3-edge floor was
     * originally chosen to avoid. The 6-edge ceiling bounds it. Prove, through the
     * real system under genuine contention, that two trains circulating the
     * learned-fast ring both keep making forward progress and never deadlock.
     *
     * Eight markers, two trains offset by half a loop: even at the 6-edge ceiling the
     * leader cannot lock the whole ring, so the chaser always has a block to take. */
    env = startPhysicsEnv(buildScene());

    env.spawnTrain('T1', { atMarker: 'S1' });
    env.spawnTrain('T2', { atMarker: 'S5' });
    /* Both circulate the full ring, offset by half a loop. Two stops each (a
     * single-stop schedule parks the train at its terminus). */
    env.assignSchedule('T1', ['S1', 'S5']);
    env.assignSchedule('T2', ['S5', 'S1']);

    /* Warm-up so the per-edge EWMA populates and the horizon grows. */
    env.advance(10_000);

    const windowStart = env.events.at(-1)?.at_ms ?? 0;
    env.advance(40_000);

    const crossingsAfter = (trainId: string): number =>
      env
        .eventsOfType('marker_traversed')
        .filter(
          (e) =>
            e.at_ms > windowStart && (e.payload as { train_id?: unknown }).train_id === trainId,
        ).length;

    /* Both trains kept moving through the learned, grown-horizon steady state — neither
     * starved behind the other. Continued forward progress over a long window is
     * exactly the absence of deadlock: a deadlocked pair makes zero crossings from the
     * moment the cycle forms. */
    expect(crossingsAfter('T1')).toBeGreaterThanOrEqual(3);
    expect(crossingsAfter('T2')).toBeGreaterThanOrEqual(3);
  });
});
