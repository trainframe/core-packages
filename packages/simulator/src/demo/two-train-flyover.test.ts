/**
 * STRICT DETERMINISTIC TWO-TRAIN FLYOVER GATE.
 *
 * This is the definition of done for the bridge demo: a real
 * Server + Scheduler + Simulation + in-process broker (no mocks), a fixed seed,
 * the pristine fault profile (zero sensor noise so a long correctness run never
 * flakes), and the injected virtual clock from the dwell-clock fix so a
 * synchronous `env.advance(ms)` deterministically expires station dwell.
 *
 * It boots the EXACT `buildBridgeDemo()` topology, registers both length-aware
 * trains and the diverge-junction switch motor, assigns the two proven
 * schedules, advances a long run, and asserts ALL of:
 *
 *   (a) NO DEADLOCK / continuous: each train visits its own ground station
 *       >= 2 times (>= 2 full laps) AND makes steady marker progress right up
 *       to the end of the run (a late traversal — not "2 laps then stall").
 *   (b) A FULLY traverses the bridge each lap, NOT a bounce: A's marker stream
 *       contains, IN ORDER and repeatedly, the bridge spine
 *       [ramp-up, upper station, ramp-down] followed by the merge junction J2 —
 *       i.e. up one side and DOWN THE FAR side. A touch-and-return omits the
 *       tail and FAILS the ordered-subsequence check.
 *   (c) B NEVER visits any deck/ramp/upper marker (stays on the ground) and
 *       completes >= 2 laps too.
 *   (d) the diverge switch flips (divert for A, main for B) across the run.
 *
 * This test MUST fail on a bounce and on a deadlock. It replaces live
 * observation as the gate the clean topology + schedules are tuned against.
 */

import { startTestEnvironment } from '@trainframe/simulator/testing';
import { describe, expect, it } from 'vitest';
import { compileLayout } from '../track/layout-from-pieces.js';
import { buildBridgeDemo } from './bridge-demo.js';

const SEED = 7;
const RUN_MS = 600_000;

/** The ordered marker stream a train crossed, from `marker_traversed` events. */
function markerStream(
  events: ReadonlyArray<{ event_type: string; device_id: string; payload: unknown }>,
  trainId: string,
): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.event_type !== 'marker_traversed') continue;
    const p = e.payload as { train_id?: unknown; marker_id?: unknown };
    if (p.train_id !== trainId) continue;
    if (typeof p.marker_id === 'string') out.push(p.marker_id);
  }
  return out;
}

/** How many times `marker` appears in the stream. */
function countOf(stream: ReadonlyArray<string>, marker: string): number {
  return stream.filter((m) => m === marker).length;
}

/**
 * True when `needles` appear as an ordered (not necessarily contiguous)
 * subsequence within `stream`. Used to prove A climbs → upper → descends far →
 * merge IN ORDER on a lap, so a touch-and-return (which omits the descent + J2)
 * fails.
 */
function containsOrdered(stream: ReadonlyArray<string>, needles: ReadonlyArray<string>): boolean {
  let i = 0;
  for (const m of stream) {
    if (i < needles.length && m === needles[i]) i++;
  }
  return i === needles.length;
}

/**
 * The number of times the full ordered spine `needles` repeats end-to-end in
 * `stream` (greedy, non-overlapping). >= 2 proves A traverses the whole bridge
 * on multiple laps rather than once.
 */
function orderedRepeats(stream: ReadonlyArray<string>, needles: ReadonlyArray<string>): number {
  let repeats = 0;
  let i = 0;
  for (const m of stream) {
    if (m === needles[i]) {
      i++;
      if (i === needles.length) {
        repeats++;
        i = 0;
      }
    }
  }
  return repeats;
}

describe('two-train flyover — strict deterministic gate', () => {
  it('both trains circulate forever; A rides the full bridge, B stays grounded, the switch flips', () => {
    const demo = buildBridgeDemo();
    const layout = compileLayout(demo.pieces, 'bridge-demo');

    const env = startTestEnvironment({ layout, seed: SEED, faults: 'pristine' });

    const [groundA, groundB] = demo.groundStations;
    if (groundA === undefined || groundB === undefined) {
      throw new Error('expected two ground stations');
    }
    const { rampUp, upper, rampDown } = demo.bridgeSpine;

    // Spawn the diverge-junction switch motor and BOTH length-aware trains. We do
    // NOT pre-pin the switch: the scheduler autonomously throws it (commit
    // f22ea41), and assertion (d) verifies that.
    env.simulation.spawnSwitch('SWITCH-j1', demo.junctionId);
    // Each train starts ON its home ground station, facing the circulation
    // direction (the forward outgoing edge). stops[0] of each schedule equals
    // the start marker, as the scheduler requires. We spawn via `env.spawnTrain`
    // (NOT `env.simulation.spawnTrain`) so the PRISTINE fault profile is applied
    // — the raw simulation path defaults to noisy physics (1% miss), which would
    // make this strict correctness gate flaky.
    env.spawnTrain(demo.trainAId, {
      startEdge: { from_marker_id: groundA, to_marker_id: demo.forwardFromGroundA },
      config: { length_mm: 60 },
    });
    env.spawnTrain(demo.trainBId, {
      startEdge: { from_marker_id: groundB, to_marker_id: demo.forwardFromGroundB },
      config: { length_mm: 60 },
    });
    // Let device_registered + first tag_observed reach the server's scheduler.
    env.advance(500);

    // Train A: a COMPLETE waypoint sequence pinning the whole lap so the only
    // forward path is up-over-and-DOWN-THE-FAR-SIDE. Home (groundA) → upper
    // (forces J1 divert + climb) → far ramp base (forces continuing down the
    // FAR side past J2, never a bounce) → groundB → top waypoint (pins the
    // return leg the long way round the oval — same direction as B, so the
    // shared single-track section never sees a head-on).
    env.assignSchedule(demo.trainAId, [groundA, upper, rampDown, groundB, demo.loopWaypoint], 'rA');
    // Train B: light ground loop. The top waypoint direction-pins its return
    // leg the long way round (same direction as A); the main-bypass waypoint
    // keeps it on the ground straight under the deck (never on the bridge).
    env.assignSchedule(demo.trainBId, [groundB, demo.loopWaypoint, demo.mainWaypoint], 'rB');

    env.advance(RUN_MS);

    const aStream = markerStream(env.events, demo.trainAId);
    const bStream = markerStream(env.events, demo.trainBId);

    // ---- (a) no deadlock / continuous, both trains ----
    expect(countOf(aStream, groundA)).toBeGreaterThanOrEqual(2);
    expect(countOf(bStream, groundB)).toBeGreaterThanOrEqual(2);
    // Steady progress to the END of the run: each train must have a traversal in
    // the final 20% of the advanced window (rules out "2 laps then stall").
    const tail = RUN_MS * 0.8;
    const lateA = env.events.some(
      (e) =>
        e.event_type === 'marker_traversed' &&
        (e.payload as { train_id?: unknown }).train_id === demo.trainAId &&
        e.at_ms >= tail,
    );
    const lateB = env.events.some(
      (e) =>
        e.event_type === 'marker_traversed' &&
        (e.payload as { train_id?: unknown }).train_id === demo.trainBId &&
        e.at_ms >= tail,
    );
    expect(lateA).toBe(true);
    expect(lateB).toBe(true);

    // ---- (b) A rides the FULL bridge each lap, in order (no bounce) ----
    const spine = [rampUp, upper, rampDown, demo.mergeJunctionId];
    expect(containsOrdered(aStream, spine)).toBe(true);
    // The full ordered spine repeats across laps — not a one-off.
    expect(orderedRepeats(aStream, spine)).toBeGreaterThanOrEqual(2);

    // ---- (c) B NEVER touches the deck/ramp/upper; B loops ----
    const bridgeMarkers = new Set([rampUp, upper, rampDown]);
    for (const m of bStream) {
      expect(bridgeMarkers.has(m)).toBe(false);
    }
    expect(countOf(bStream, demo.loopWaypoint)).toBeGreaterThanOrEqual(2);

    // ---- (d) the diverge switch flips both ways across the run ----
    const switchPositions = new Set(
      env
        .getEventsOfType('switch_state_changed')
        .map((e) => (e.payload as { position?: unknown }).position)
        .filter((p): p is string => typeof p === 'string'),
    );
    expect(switchPositions.has('divert')).toBe(true);
    expect(switchPositions.has('main')).toBe(true);

    env.shutdown();
  });
});
