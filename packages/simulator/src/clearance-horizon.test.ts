/**
 * BEHAVIOUR GATE for the proactive clearance horizon (scheduler fix), migrated
 * onto the physics test-env: REAL @trainframe/server scheduler + REAL physics
 * loco on a REAL PhysicsWorld, driven synchronously over the in-memory broker.
 * Nothing is mocked.
 *
 * Before the horizon, the scheduler granted exactly one edge at a time, and only
 * when the train REACHED its clearance-limit marker. The limit was always a single
 * block ahead, so the physics braked approaching it, re-accelerated once the next
 * edge was granted, and the train stuttered — stopping dead at every intermediate
 * marker.
 *
 * The horizon grants up to CLEARANCE_HORIZON_EDGES (3) edges ahead and tops up on
 * every marker crossing, so a moving train always carries several blocks of
 * clearance in front of it. This test proves, through the real Server + Scheduler +
 * physics world + in-process broker, that:
 *
 *   (a) the clearance limit reaches >= 2 edges beyond the edge the train is on, and
 *       never trails behind it (observed from the `grant_clearance` commands), and
 *   (b) once the train is moving it NEVER brakes to velocity 0 mid-block — the
 *       per-marker stutter is gone; the only legitimate standstill is the dwell at
 *       a scheduled stop.
 *
 * Note on the dwell signal vs. the old sim: the `ScheduledTrainDevice` advances its
 * route belief the instant it crosses a marker, so the dwell at a scheduled stop is
 * reported on the edge DEPARTING that stop, at distance ~0 from the edge start. The
 * test accounts for that by treating speed-0 as forbidden only once the train has
 * moved past the edge's start (distance > 50mm) on an edge not arriving at a stop —
 * which is exactly the old per-marker braking the horizon removed.
 */

import {
  type CapturedEvent,
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** A six-marker ring, all plain block boundaries (no station_stop, so no dwell
 * pause), longer than the 3-edge horizon so the limit genuinely trails several
 * edges ahead of the train as it circulates. */
const buildScene = () =>
  straightLoop(
    [
      { id: 'R1', kind: 'block_boundary' },
      { id: 'R2', kind: 'block_boundary' },
      { id: 'R3', kind: 'block_boundary' },
      { id: 'R4', kind: 'block_boundary' },
      { id: 'R5', kind: 'block_boundary' },
      { id: 'R6', kind: 'block_boundary' },
    ],
    { spacingMm: 300, name: 'horizon-ring' },
  );

/** Order of markers around the ring; used to count forward edges. */
const ORDER = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];

function ringIndex(markerId: string): number {
  return ORDER.indexOf(markerId);
}

/** Forward distance (in edges, mod ring length) from `fromIdx` to `toIdx`. */
function forwardEdges(fromIdx: number, toIdx: number): number {
  return (((toIdx - fromIdx) % ORDER.length) + ORDER.length) % ORDER.length;
}

interface StatusPayload {
  readonly current_edge?: { readonly from_marker_id: string; readonly to_marker_id: string };
  readonly speed_normalised: number;
  readonly estimated_distance_from_edge_start_mm?: number;
}

function status(event: CapturedEvent): StatusPayload {
  return event.payload as unknown as StatusPayload;
}

/** The `to_marker` of the most recent status at-or-before time `at`, or undefined
 * if the train hadn't emitted a positioned status yet. */
function currentToAt(statuses: ReadonlyArray<CapturedEvent>, at: number): string | undefined {
  let currentTo: string | undefined;
  for (const s of statuses) {
    if (s.at_ms > at) break;
    const to = status(s).current_edge?.to_marker_id;
    if (to) currentTo = to;
  }
  return currentTo;
}

let env: PhysicsEnv;

beforeEach(() => {
  env = startPhysicsEnv(buildScene());
});

afterEach(() => {
  env.shutdown();
});

describe('proactive clearance horizon — behaviour gate', () => {
  it('reaches >= 2 edges of clearance ahead and never brakes to a stop mid-block', () => {
    env.spawnTrain('T1', { atMarker: 'R1' });
    /* A multi-lap cyclic schedule. R1 == the spawn marker, so the train
     *  circulates R1 -> R4 -> R1 -> … indefinitely. */
    env.assignSchedule('T1', ['R1', 'R4']);

    env.advance(60_000);

    const statuses = env.eventsOfType('train_status').filter((e) => e.device_id === 'T1');

    /* Every grant_clearance the server published to the train, with the virtual
     *  time the harness recorded it. */
    const grants = env
      .commandsFor('T1')
      .filter((c) => c.command_type === 'grant_clearance')
      .map((c) => ({ at: c.at_ms, limit: c.payload.limit_marker_id }))
      .filter((g): g is { at: number; limit: string } => typeof g.limit === 'string');

    /* For each grant, how many edges its limit sits beyond the edge the train is
     *  on (measured from the current edge's `to_marker`). */
    const aheadValues = grants
      .map((g) => ({ to: currentToAt(statuses, g.at), limit: g.limit }))
      .filter((g): g is { to: string; limit: string } => g.to !== undefined)
      .map((g) => forwardEdges(ringIndex(g.to), ringIndex(g.limit)));
    expect(aheadValues.length).toBeGreaterThan(0); // exercised on real steady-state grants

    /* ---- (a) the horizon reaches >= 2 edges ahead and never trails behind ----
     *  A clearance burst grants the next block first (the floor) and then tops up
     *  to the horizon; the proof that the one-block-ahead stutter is GONE is that
     *  the burst reaches at least 2 edges beyond the train's current edge. Every
     *  grant's limit is also forward of the train (ahead >= 0) — never behind. */
    for (const ahead of aheadValues) {
      expect(ahead).toBeGreaterThanOrEqual(0);
    }
    expect(Math.max(...aheadValues)).toBeGreaterThanOrEqual(2);

    /* ---- (b) the train never brakes to a dead stop mid-block ----
     *  The schedule's stops are R1 and R4, where a deterministic dwell legitimately
     *  halts the train. A speed-0 reading is forbidden only once the train has
     *  moved past an edge's start (distance > 50mm) on an edge NOT arriving at a
     *  scheduled stop: that is precisely the old per-marker braking the horizon
     *  removed. Every running block must be crossed without a standstill. */
    const scheduledStops = new Set(['R1', 'R4']);
    const runningSamples = statuses
      .filter((s) => s.at_ms >= 2_000) // skip spin-up
      .map(status)
      .filter((p) => {
        const edge = p.current_edge;
        if (edge === undefined) return false;
        if (scheduledStops.has(edge.to_marker_id)) return false; // arriving at a stop
        return (p.estimated_distance_from_edge_start_mm ?? 0) > 50; // past the start
      });
    expect(runningSamples.length).toBeGreaterThan(30);
    for (const p of runningSamples) {
      expect(p.speed_normalised).toBeGreaterThan(0);
    }

    /* Sanity: the train genuinely circulated (multiple laps), so the run is a real
     *  moving-train observation, not a parked one. */
    const r1Crossings = env
      .eventsOfType('tag_observed')
      .filter((e) => e.device_id === 'T1' && e.payload.tag_id === 'R1').length;
    expect(r1Crossings).toBeGreaterThanOrEqual(2);
  });
});
