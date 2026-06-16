/**
 * BEHAVIOUR GATE for the ADR-017 conflict-resolution policy, driven end to end
 * through the REAL `@trainframe/server` scheduler, REAL physics `GateDevice` +
 * `ScheduledTrainDevice`, and the synchronous in-memory broker. Nothing is mocked.
 *
 * ADR-017 replaces the incidental `Map`-iteration tiebreak with an explicit,
 * deterministic total order over trains: announced priority → registration
 * sequence (the FIFO-by-arrival floor) → `train_id`. When two trains contend for
 * one free section, the highest-ranked is granted it and block exclusivity
 * (ADR-011) denies the rest; the order is a pure function of state the scheduler
 * already holds, so the SAME setup produces the SAME winner every run.
 *
 * The scenario is a wishbone: two approach arms (A1→J and B1→J) merge at the
 * junction marker J. A gate over J holds both trains one block back — neither can
 * be cleared into J's block while it is withheld. Releasing the gate triggers a
 * single ordered retry pass: exactly one train is granted the contested edge into
 * J. With equal (default) priority the registration-sequence floor decides, so the
 * first-registered train wins — the same winner on every run.
 *
 * This file proves, over the real broker:
 *   (a) two trains contend for one shared junction → the contention resolves to a
 *       single definite winner (one is granted J; the other is denied, held one
 *       block back under block exclusivity); and
 *   (b) determinism: re-running the identical setup yields the same winner every
 *       time — the reproducibility the ADR's total order guarantees.
 *
 * The priority and registration-order *terms* of the order are exercised directly
 * at the scheduler level (see `packages/core/src/scheduler/scheduler.test.ts`).
 */

import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CapturedCommand,
  type PhysicsEnv,
  type PhysicsScene,
  startPhysicsEnv,
  straightLoop,
} from './physics-env.js';

/**
 * A wishbone over a single physics rail: two approach arms (A1→J and B1→J) merge
 * at the junction J, then a single onward stem J→C closes back to the arms. The
 * physics geometry is an inert straight loop — the gate holds both trains stopped
 * one block short of J, so neither body ever moves; the contention is decided in
 * the scheduler the moment the gate releases. What the scheduler reasons on is the
 * wishbone `Layout`: two distinct edges feed J, so two trains can genuinely
 * contend for the single section into J.
 */
const buildWishbone = (): PhysicsScene => {
  const base = straightLoop(
    [
      { id: 'A1', kind: 'block_boundary' },
      { id: 'B1', kind: 'block_boundary' },
      { id: 'J', kind: 'block_boundary' },
      { id: 'C', kind: 'block_boundary' },
    ],
    { spacingMm: 200, name: 'wishbone' },
  );
  /* Override only the logical graph with the wishbone merge. The markers (and
   * their world positions, far enough apart that the two parked bodies never
   * touch) and the physics net are kept from the loop; only the edges the
   * scheduler routes on change. */
  const layout: Layout = {
    name: base.layout.name,
    markers: base.layout.markers,
    edges: [
      { from_marker_id: 'A1', to_marker_id: 'J', estimated_length_mm: 200 },
      { from_marker_id: 'B1', to_marker_id: 'J', estimated_length_mm: 200 },
      { from_marker_id: 'J', to_marker_id: 'C', estimated_length_mm: 200 },
      { from_marker_id: 'C', to_marker_id: 'A1', estimated_length_mm: 200 },
      { from_marker_id: 'C', to_marker_id: 'B1', estimated_length_mm: 200 },
    ],
    junctions: [],
  };
  return { net: base.net, layout, markers: base.markers };
};

const grantInto = (env: PhysicsEnv, trainId: string, limit: string): readonly CapturedCommand[] =>
  env
    .commandsFor(trainId)
    .filter((c) => c.command_type === 'grant_clearance' && c.payload.limit_marker_id === limit);

/**
 * Run the contention once. Spawn `first` then `second` (registration order is the
 * FIFO floor under ADR-017), hold the gate over J, route both arms onward through
 * J, release the gate, and return the id of the train granted the contested edge
 * into J — the one that won the merge.
 */
const winnerOfContention = (first: string, second: string): string | undefined => {
  const env = startPhysicsEnv(buildWishbone());
  try {
    /* A gate over J, registered with core.gates_clearance, held before either
     * train has any clearance toward J. While withheld the scheduler vetoes any
     * clearance whose limit is J, so both arms are denied the merge. */
    const gate = env.spawnGate('GATE-J', { markers: ['J'] });
    gate.hold('J', 'contention test');

    /* `first` registers before `second`: lower registration-sequence, the FIFO
     * floor. Each parks on its own arm (A1 and B1, distinct world points) and is
     * routed onward through the merge: both need the single edge into J. */
    env.spawnTrain(first, { atMarker: 'A1' });
    env.spawnTrain(second, { atMarker: 'B1' });
    env.assignSchedule(first, ['A1', 'C']);
    env.assignSchedule(second, ['B1', 'C']);
    env.advance(1000);

    // While the gate withholds J, neither arm is cleared into the merge.
    expect(grantInto(env, first, 'J')).toHaveLength(0);
    expect(grantInto(env, second, 'J')).toHaveLength(0);

    /* Release the gate: one ordered retry pass decides. The higher-ranked train
     * (here, the first-registered) takes the edge into J; block exclusivity then
     * denies the other, which stays held one block back. */
    gate.release('J');
    env.advance(1000);

    const firstWon = grantInto(env, first, 'J').length > 0;
    const secondWon = grantInto(env, second, 'J').length > 0;
    if (firstWon) return first;
    if (secondWon) return second;
    return undefined;
  } finally {
    env.shutdown();
  }
};

describe('conflict-resolution policy — behaviour gate (ADR-017)', () => {
  it('resolves the contested junction to a single definite winner', () => {
    // Exactly one train is granted the edge into J; the contention does not stall
    // both nor grant both (block exclusivity + the ordered grant path leave one
    // definite winner).
    const env = startPhysicsEnv(buildWishbone());
    try {
      const gate = env.spawnGate('GATE-J', { markers: ['J'] });
      gate.hold('J', 'contention test');
      env.spawnTrain('TA', { atMarker: 'A1' });
      env.spawnTrain('TB', { atMarker: 'B1' });
      env.assignSchedule('TA', ['A1', 'C']);
      env.assignSchedule('TB', ['B1', 'C']);
      env.advance(1000);

      gate.release('J');
      env.advance(1000);

      const taWon = grantInto(env, 'TA', 'J').length > 0;
      const tbWon = grantInto(env, 'TB', 'J').length > 0;
      // One winner, not both: exactly one of the two holds the contested edge.
      expect(taWon !== tbWon).toBe(true);
    } finally {
      env.shutdown();
    }
  });

  it('is deterministic: the same setup yields the same winner across runs', () => {
    const winners = new Set<string | undefined>();
    for (let run = 0; run < 4; run++) {
      winners.add(winnerOfContention('TA', 'TB'));
    }
    // One value across every run — the total order makes the contended grant
    // reproducible with no RNG and no wall clock in the loop.
    expect(winners.size).toBe(1);
    const [only] = [...winners];
    expect(only).toBe('TA');
  });

  it('the FIFO floor decides: the first-registered arm wins, independent of spawn label', () => {
    // Swapping which id registers first swaps the winner — the registration
    // sequence (not the train_id, not Map order) is what arbitrates equal-priority
    // contention. TB-first wins when registered first; TA-first wins when first.
    expect(winnerOfContention('TB', 'TA')).toBe('TB');
    expect(winnerOfContention('TA', 'TB')).toBe('TA');
  });
});
