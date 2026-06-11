import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation, type VirtualCarriage } from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * The railyard carriage-swap LOOP, proven through the real stack (broker +
 * server + scheduler + simulation) — the headless backbone of the toy-table
 * demo, deterministic so the feature's correctness never depends on a browser.
 *
 * What it exercises end-to-end:
 *  - ADR-027 handoff: a reversible train routed to the yard throat as its route
 *    *terminus* is suspended there by the scheduler (`in_zone`), holding no block.
 *  - The yard's opaque-interior rearrange (ADR-026): while the train is
 *    suspended the device swaps its leading pair for its spares and releases it
 *    (`zone_train_released`), all of which core sees only as occupancy + a
 *    release — never the carriages themselves (ADR-016).
 *  - Release-then-continue: the reclaimed train accepts a fresh onward leg and
 *    departs (the loop's heartbeat).
 *  - The headline: a wagon MIGRATES between trains. T1 drops its red pair into
 *    the yard; T2, arriving later, leaves wearing it. Proof a coloured carriage
 *    can be tracked moving from train to train — what the demo exists to show.
 *
 * Kept deterministic by running the two trains in sequence (T1 finishes its lap
 * and leaves the table before T2 arrives), so there is no block contention to
 * race. The live, concurrent four-train version is the by-hand Playwright
 * journey; this test is its load-bearing correctness proof.
 */

const LOOP: Layout = {
  name: 'railyard-swap-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'yard_entry' },
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
let simBrokerClient: MqttBrokerClient;
let bridge: BrokerBridge;
let simulation: Simulation;

beforeEach(async () => {
  harness = await startHarness({ layout: LOOP });
  await harness.testClient.seedIdentityTags(['M1', 'M2', 'M3', 'M4']);

  simulation = new Simulation({ layout: LOOP, seed: 1 });
  simulation.seedIdentityTags(LOOP);

  simBrokerClient = new MqttBrokerClient();
  await simBrokerClient.connect(harness.brokerUrl);
  bridge = new BrokerBridge(simulation, simBrokerClient, { newId: () => randomUUID() });
  bridge.start();
});

afterEach(async () => {
  bridge.stop();
  await simBrokerClient.disconnect();
  await harness.shutdown();
});

const rake = (livery: string): VirtualCarriage[] =>
  [1, 2, 3, 4].map((n) => ({ id: `${livery}${n}`, colorId: livery }));

const liveriesOf = (trainId: string): string[] =>
  (simulation.getTrain(trainId)?.getConsist() ?? []).map((c) => c.colorId ?? '');

/** Advance the sim in small steps until `predicate` holds, or fail after timeout. */
const advanceUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 8000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    simulation.advance(50);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out: ${message}`);
};

/** True once the yard has emitted a `zone_train_released` for this train. */
const released = (trainId: string): boolean =>
  harness.testClient
    .events()
    .some(
      (e) =>
        e.event_type === 'zone_train_released' &&
        (e.payload as { train_id: string }).train_id === trainId,
    );

const spawnReversibleTrain = async (trainId: string, livery: string): Promise<void> => {
  simulation.spawnTrain(trainId, {
    startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    config: { can_reverse: true, length_mm: 60 },
  });
  simulation.setTrainConsist(trainId, rake(livery));
  await harness.testClient.waitForState(`railway/state/devices/${trainId}`);
};

describe('Railyard carriage-swap loop (ADR-026/027, end-to-end)', () => {
  it('shunts a wagon from one train onto the next through the yard', async () => {
    // A 6-slot yard at the M3 throat, pre-loaded with two purple spares.
    const yard = simulation.spawnRailyard('YARD-1', 'M3', 6);
    yard.loadSpares([
      { id: 'P1', colorId: 'purple' },
      { id: 'P2', colorId: 'purple' },
    ]);
    await harness.testClient.waitForState('railway/state/devices/YARD-1');

    // --- T1 (red rake) visits the yard ------------------------------------
    // One CYCLIC schedule calling at the yard each lap (M1 ↔ M3) — the operator
    // assigns it once; the scheduler suspends at the throat and resumes the
    // loop on release itself (ADR-028), no per-lap re-assignment.
    await spawnReversibleTrain('T1', 'red');
    harness.server.assignSchedule('T1', 't1-loop', ['M1', 'M3']);

    // It is admitted, pulls into the throat as its terminus, is suspended,
    // swapped, and released — all without us touching the carriages.
    await advanceUntil(() => released('T1'), 'T1 released from the yard');

    // T1 keeps its front pair and leaves with the purple spares coupled on its
    // REAR; its rear red pair was shed in the yard.
    expect(liveriesOf('T1').slice(-2)).toEqual(['purple', 'purple']);
    expect(liveriesOf('T1')).toContain('red');
    // The yard keeps T1's shed red pair as the next spares.
    expect(yard.getSpares().map((c) => c.colorId)).toEqual(['red', 'red']);

    // Release-then-resume (ADR-028): with no operator re-assignment, T1 is
    // routed onward off the throat — it receives a SECOND assign_route (the
    // resumed leg) and drives out, closing its lap.
    await advanceUntil(
      () =>
        harness.testClient.commandsFor('T1').filter((c) => c.command_type === 'assign_route')
          .length >= 2,
      'the scheduler resumes T1 onward without re-assignment',
    );

    // T1 leaves the table so the next train arrives uncontended.
    simulation.despawnTrain('T1');

    // --- T2 (green rake) visits the yard ----------------------------------
    await spawnReversibleTrain('T2', 'green');
    harness.server.assignSchedule('T2', 't2-loop', ['M1', 'M3']);
    await advanceUntil(() => released('T2'), 'T2 released from the yard');

    // The headline: T2 leaves the yard wearing the RED wagons T1 brought in
    // (coupled on its rear). A carriage has migrated from one train to another,
    // via the yard, with core none the wiser (it only ever saw occupancy + a
    // release).
    expect(liveriesOf('T2').slice(-2)).toEqual(['red', 'red']);
    expect(liveriesOf('T2')).toContain('green');
  });
});
