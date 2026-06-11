import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation, type VirtualCarriage } from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * CONCURRENCY PROBE for the multi-train railyard demo.
 *
 * The deterministic `railyard-swap-loop` test deliberately runs its two trains
 * IN SEQUENCE (T1 leaves the table before T2 arrives) so there is never block
 * contention. The live demo wants the opposite: several trains circulating the
 * SAME loop AT THE SAME TIME, each calling at the single-marker yard zone — and
 * CLAUDE.md lists "conflict resolution policy for clearance contention between
 * trains" as an OPEN design question. So before building the demo layout we must
 * answer one question cheaply: does the scheduler let trains queue through the
 * zone and keep circulating, or do they DEADLOCK?
 *
 * Pass criterion is NO DEADLOCK, not zero contention: a train waiting its turn
 * behind the yard is fine (a real yard queues too). We prove it by routing TWO
 * trains concurrently, both with cyclic schedules that call at the yard, and
 * asserting BOTH are admitted, swapped, and released — and that a wagon still
 * migrates from the first train to the second through the yard.
 *
 * If this ever starts to fail (one train never released), that is the open
 * design question biting: surface it before changing the scheduler.
 */

/** A 6-block loop so two trains have room to circulate without false block
 *  starvation — isolating the ZONE-contention question from mere loop size.
 *  M3 is the yard throat. */
const LOOP: Layout = {
  name: 'railyard-swap-concurrent',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'yard_entry' },
    { id: 'M4', kind: 'block_boundary' },
    { id: 'M5', kind: 'block_boundary' },
    { id: 'M6', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M5', estimated_length_mm: 200 },
    { from_marker_id: 'M5', to_marker_id: 'M6', estimated_length_mm: 200 },
    { from_marker_id: 'M6', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

const ALL_MARKERS = LOOP.markers.map((m) => m.id);

let harness: Harness;
let simBrokerClient: MqttBrokerClient;
let bridge: BrokerBridge;
let simulation: Simulation;

beforeEach(async () => {
  harness = await startHarness({ layout: LOOP });
  await harness.testClient.seedIdentityTags(ALL_MARKERS);

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

const released = (trainId: string): boolean =>
  harness.testClient
    .events()
    .some(
      (e) =>
        e.event_type === 'zone_train_released' &&
        (e.payload as { train_id: string }).train_id === trainId,
    );

const advanceUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    simulation.advance(50);
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`Timed out: ${message}`);
};

const spawnReversibleTrain = async (
  trainId: string,
  livery: string,
  startEdge: { from_marker_id: string; to_marker_id: string },
): Promise<void> => {
  simulation.spawnTrain(trainId, { startEdge, config: { can_reverse: true, length_mm: 60 } });
  simulation.setTrainConsist(trainId, rake(livery));
  await harness.testClient.waitForState(`railway/state/devices/${trainId}`);
};

describe('Railyard zone under CONCURRENT trains (deadlock probe)', () => {
  it('queues two trains through the yard without deadlock — and a wagon still migrates', async () => {
    const yard = simulation.spawnRailyard('YARD-1', 'M3', 6);
    yard.loadSpares([
      { id: 'P1', colorId: 'purple' },
      { id: 'P2', colorId: 'purple' },
    ]);
    await harness.testClient.waitForState('railway/state/devices/YARD-1');

    // Both trains live AT ONCE, spaced ~half a loop apart, same direction. Each
    // gets a cyclic schedule calling at the yard throat (M3). The scheduler must
    // serialise them through the zone (one inside at a time) while both keep
    // circulating — no operator intervention per lap (ADR-028 resume).
    await spawnReversibleTrain('T1', 'red', { from_marker_id: 'M1', to_marker_id: 'M2' });
    await spawnReversibleTrain('T2', 'green', { from_marker_id: 'M4', to_marker_id: 'M5' });

    harness.server.assignSchedule('T1', 't1-loop', ['M1', 'M3']);
    harness.server.assignSchedule('T2', 't2-loop', ['M4', 'M3']);

    // No deadlock: T1 is admitted, swapped, released — THEN, with both trains on
    // the loop the whole time, T2 is admitted, swapped, released too.
    await advanceUntil(() => released('T1'), 'T1 released from the yard (concurrent)');
    await advanceUntil(() => released('T2'), 'T2 released from the yard (concurrent)');

    // The headline still holds under contention: T1 shed its red pair into the
    // yard and left with the purple spares on its rear; T2 then left wearing T1's
    // red pair. A wagon migrated train→train through the zone.
    expect(liveriesOf('T1').slice(-2)).toEqual(['purple', 'purple']);
    expect(liveriesOf('T2').slice(-2)).toEqual(['red', 'red']);
  });
});
