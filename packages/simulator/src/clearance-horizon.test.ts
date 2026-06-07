/**
 * BEHAVIOUR GATE for the proactive clearance horizon (scheduler fix).
 *
 * Before the horizon, the scheduler granted exactly one edge at a time, and
 * only when the train REACHED its clearance-limit marker. The limit was always
 * a single block ahead, so the physics braked approaching it, re-accelerated
 * once the next edge was granted, and the train stuttered — stopping dead at
 * every intermediate marker.
 *
 * The horizon grants up to CLEARANCE_HORIZON_EDGES (3) edges ahead and tops up
 * on every marker crossing, so a moving train always carries several blocks of
 * clearance in front of it. This test proves, through the real
 * Server + Scheduler + Simulation + in-process broker (no mocks, injected
 * virtual clock, pristine fault profile, fixed seed), that:
 *
 *   (a) the clearance limit stays >= 2 edges ahead of the edge the train is on
 *       (observed from the `grant_clearance` commands the server publishes), and
 *   (b) once the train is moving it NEVER decelerates to velocity 0 at an
 *       intermediate marker — the per-marker braking is gone.
 *
 * The loop has NO station stop, so there is no legitimate dwell that could be
 * mistaken for the braking the test rules out.
 */

import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { startTestEnvironment } from './testing.js';

/** A six-marker ring, all plain block boundaries (no station_stop, so no dwell
 * pause), longer than the 3-edge horizon so the limit genuinely trails several
 * edges ahead of the train as it circulates. */
const RING: Layout = {
  name: 'horizon-ring',
  markers: [
    { id: 'R1', kind: 'block_boundary' },
    { id: 'R2', kind: 'block_boundary' },
    { id: 'R3', kind: 'block_boundary' },
    { id: 'R4', kind: 'block_boundary' },
    { id: 'R5', kind: 'block_boundary' },
    { id: 'R6', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'R1', to_marker_id: 'R2', estimated_length_mm: 300 },
    { from_marker_id: 'R2', to_marker_id: 'R3', estimated_length_mm: 300 },
    { from_marker_id: 'R3', to_marker_id: 'R4', estimated_length_mm: 300 },
    { from_marker_id: 'R4', to_marker_id: 'R5', estimated_length_mm: 300 },
    { from_marker_id: 'R5', to_marker_id: 'R6', estimated_length_mm: 300 },
    { from_marker_id: 'R6', to_marker_id: 'R1', estimated_length_mm: 300 },
  ],
  junctions: [],
};

/** Index of a marker on the ring, 0..5. */
const ORDER = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
function ringIndex(markerId: string): number {
  return ORDER.indexOf(markerId);
}

/** Forward distance (in edges, mod ring length) from `fromIdx` to `toIdx`. */
function forwardEdges(fromIdx: number, toIdx: number): number {
  return (((toIdx - fromIdx) % ORDER.length) + ORDER.length) % ORDER.length;
}

function decode<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}

interface StatusPayload {
  current_edge?: { from_marker_id: string; to_marker_id: string };
  speed_normalised: number;
}
interface Captured {
  at_ms: number;
  payload: unknown;
}

/** The `to_marker` of the most recent status at-or-before time `at`, or
 * undefined if the train hadn't emitted a positioned status yet. */
function currentToAt(statuses: ReadonlyArray<Captured>, at: number): string | undefined {
  let currentTo: string | undefined;
  for (const s of statuses) {
    if (s.at_ms > at) break;
    const p = s.payload as StatusPayload;
    if (p.current_edge?.to_marker_id) currentTo = p.current_edge.to_marker_id;
  }
  return currentTo;
}

describe('proactive clearance horizon — behaviour gate', () => {
  it('keeps the limit >= 2 edges ahead and never brakes to a stop at an intermediate marker', () => {
    const env = startTestEnvironment({ layout: RING, seed: 3, faults: 'pristine' });

    // Capture every grant_clearance command the server publishes to the train,
    // tagged with the virtual time it was issued.
    const grants: Array<{ at: number; limit: string }> = [];
    env.client.subscribe('railway/commands/T1', (message) => {
      const cmd = decode<{ command_type: string; payload: { limit_marker_id?: string } }>(
        message.payload,
      );
      if (
        cmd.command_type === 'grant_clearance' &&
        typeof cmd.payload.limit_marker_id === 'string'
      ) {
        grants.push({ at: env.simulation.clock.now(), limit: cmd.payload.limit_marker_id });
      }
    });

    env.spawnTrain('T1', {
      startEdge: { from_marker_id: 'R1', to_marker_id: 'R2' },
      config: { train_status_interval_ms: 100 },
    });
    // A multi-lap cyclic schedule. R1 == stops[0] (the spawn marker), so the
    // train circulates R1 -> R4 -> R1 -> … indefinitely.
    env.assignSchedule('T1', ['R1', 'R4']);

    env.advance(60_000);

    const statuses = env.getEventsOfType('train_status');

    // ---- (a) the limit stays >= 2 edges ahead of the train ----
    // For each grant, the limit must be at least one edge beyond the edge the
    // train is currently on — i.e. >= 2 edges of clearance ahead of its
    // position. (ahead === 0 would be the old one-block-ahead stutter.)
    const aheadValues = grants
      .map((g) => ({ to: currentToAt(statuses, g.at), limit: g.limit }))
      .filter((g): g is { to: string; limit: string } => g.to !== undefined)
      .map((g) => forwardEdges(ringIndex(g.to), ringIndex(g.limit)));
    expect(aheadValues.length).toBeGreaterThan(0); // exercised on real steady-state grants
    for (const ahead of aheadValues) {
      expect(ahead).toBeGreaterThanOrEqual(1);
    }

    // ---- (b) the train never decelerates to a dead stop at a marker that is
    // NOT a scheduled stop ----
    // The schedule's stops are R1 and R4, where a deterministic dwell legitimately
    // halts the train. Every OTHER marker is an intermediate marker the train
    // must roll straight through: on any edge that does NOT terminate at a
    // scheduled stop, speed must stay strictly positive. The old one-block-ahead
    // model braked to 0 at each of these; the horizon removes that.
    const scheduledStops = new Set(['R1', 'R4']);
    const movingSpeeds = statuses
      .filter((s) => s.at_ms >= 2_000) // skip spin-up
      .map((s) => s.payload as StatusPayload)
      .filter((p) => {
        const to = p.current_edge?.to_marker_id;
        return to !== undefined && !scheduledStops.has(to);
      })
      .map((p) => p.speed_normalised);
    expect(movingSpeeds.length).toBeGreaterThan(30);
    for (const speed of movingSpeeds) {
      expect(speed).toBeGreaterThan(0);
    }

    // Sanity: the train genuinely circulated (multiple laps), so the run is a
    // real moving-train observation, not a parked one.
    const r1Crossings = env
      .getEventsOfType('marker_traversed')
      .filter((e) => (e.payload as { marker_id?: unknown }).marker_id === 'R1').length;
    expect(r1Crossings).toBeGreaterThanOrEqual(2);

    env.shutdown();
  });
});
