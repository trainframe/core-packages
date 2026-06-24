/**
 * Reproduction: does a scheduled train CYCLE its stops on a loop, indefinitely?
 * The user reports schedules "don't work on a loop as expected". This drives the
 * REAL server scheduler + REAL physics loco on a clean ring and counts how many
 * times each scheduled stop is visited — a looping schedule visits each stop many
 * times; a one-shot run visits each once then parks.
 */
import {
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const buildRing = () =>
  straightLoop(
    [
      { id: 'S1', kind: 'station_stop' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'S3', kind: 'station_stop' },
      { id: 'M4', kind: 'block_boundary' },
      { id: 'S5', kind: 'station_stop' },
      { id: 'M6', kind: 'block_boundary' },
    ],
    { spacingMm: 300, name: 'loop-repro-ring' },
  );

let env: PhysicsEnv;
beforeEach(() => {
  env = startPhysicsEnv(buildRing());
});
afterEach(() => {
  env.shutdown();
});

/* A stop is "visited" each time the train DEPARTS it — i.e. a train_status whose
   current_edge.from is the stop, after having been elsewhere. Counts distinct
   departures (the physics loco reports position via train_status, not
   marker_traversed). */
function visitCounts(trainId: string, stops: readonly string[]): Record<string, number> {
  const statuses = env.eventsOfType('train_status').filter((e) => e.device_id === trainId);
  const counts: Record<string, number> = {};
  for (const s of stops) counts[s] = 0;
  let prevFrom: string | undefined;
  for (const e of statuses) {
    const from = (e.payload as { current_edge?: { from_marker_id?: string } }).current_edge
      ?.from_marker_id;
    if (from !== undefined && from !== prevFrom) {
      if (from in counts) counts[from] = (counts[from] ?? 0) + 1;
      prevFrom = from;
    }
  }
  return counts;
}

describe('scheduled train cycles its stops on a loop', () => {
  it('a 3-stop schedule visits every stop repeatedly (loops, not one-shot)', () => {
    env.spawnTrain('T1', { atMarker: 'S1' });
    env.assignSchedule('T1', ['S1', 'S3', 'S5']);
    env.advance(180_000);
    const counts = visitCounts('T1', ['S1', 'S3', 'S5']);
    // eslint-disable-next-line no-console
    console.log('3-stop loop visit counts:', JSON.stringify(counts));
    for (const stop of ['S1', 'S3', 'S5']) {
      expect(counts[stop], `${stop} visited multiple times (loops)`).toBeGreaterThanOrEqual(2);
    }
  });

  it('a 2-stop schedule visits both stops repeatedly', () => {
    env.spawnTrain('T2', { atMarker: 'S1' });
    env.assignSchedule('T2', ['S1', 'S5']);
    env.advance(180_000);
    const counts = visitCounts('T2', ['S1', 'S5']);
    // eslint-disable-next-line no-console
    console.log('2-stop loop visit counts:', JSON.stringify(counts));
    for (const stop of ['S1', 'S5']) {
      expect(counts[stop], `${stop} visited multiple times (loops)`).toBeGreaterThanOrEqual(2);
    }
  });

  /* The diagnosis for "schedules don't loop": an UNCLOSED loop — discovery never
     inferred the closing edge (the train didn't complete a full lap) — so the
     scheduler can plan the first pass but CANNOT plan from the last stop back to
     the first (no forward edge home). The train parks after one pass. This is the
     symptom to look for in the field, NOT a scheduler bug. */
  it('an UNCLOSED loop does NOT cycle — the closing edge is what makes a loop loop', () => {
    const closed = buildRing();
    // Drop the wrap edge M6 -> S1: a loop learned without completing the lap.
    const openLayout = {
      ...closed.layout,
      edges: closed.layout.edges.filter(
        (e) => !(e.from_marker_id === 'M6' && e.to_marker_id === 'S1'),
      ),
    };
    env.shutdown();
    env = startPhysicsEnv({ ...closed, layout: openLayout });
    env.spawnTrain('T3', { atMarker: 'S1' });
    env.assignSchedule('T3', ['S1', 'S3', 'S5']);
    env.advance(180_000);
    const counts = visitCounts('T3', ['S1', 'S3', 'S5']);
    // eslint-disable-next-line no-console
    console.log('UNCLOSED loop visit counts:', JSON.stringify(counts));
    // It cannot wrap back to the first stop, so it never settles into a cycle —
    // total visits stay tiny vs the ~80 a CLOSED loop racks up in the same time.
    const total = (counts.S1 ?? 0) + (counts.S3 ?? 0) + (counts.S5 ?? 0);
    expect(total, 'an open loop does not sustain cycling (closed loop reaches ~80)').toBeLessThan(
      12,
    );
  });
});
