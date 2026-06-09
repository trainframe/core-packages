import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation } from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * Delegated capacity-territory admission (ADR-026): a railyard owns a
 * capacity-limited zone behind a single boundary marker (the throat, M3). It
 * asserts its own occupancy via `zone_state_changed`; the `core.gates_zone`
 * capability denies a train clearance INTO the zone while it is full, and the
 * scheduler's existing deny-and-hold / retry machinery admits the train the
 * moment a slot frees.
 *
 * The unique signal under test is the full operator round-trip through a real
 * broker: VirtualRailyard → zone_state_changed → server → scheduler consultation
 * → clearance held/granted. This is the railyard's headline proof — the same
 * "deny-and-hold, then auto-admit" cycle a gate uses, but keyed on a count the
 * device asserts and core cannot itself compute (carriages are invisible to
 * core, ADR-016).
 *
 * Safety-relevant: a full yard must not admit a train; a freed slot must.
 */

const LOOP: Layout = {
  name: 'zone-admission',
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

const grantsFor = (trainId: string) =>
  harness.testClient.commandsFor(trainId).filter((c) => c.command_type === 'grant_clearance');

const m3GrantsFor = (trainId: string) =>
  grantsFor(trainId).filter(
    (c) => (c.payload as { limit_marker_id: string }).limit_marker_id === 'M3',
  );

/** Wait until a zone_state_changed from the yard reports the given occupancy. */
const waitForOccupancy = async (deviceId: string, occupancy: number, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = harness.testClient
      .events()
      .some(
        (e) =>
          e.event_type === 'zone_state_changed' &&
          e.device_id === deviceId &&
          (e.payload as { occupancy: number }).occupancy === occupancy,
      );
    if (seen) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${deviceId} occupancy ${occupancy}`);
};

describe('Railyard zone admission: the scheduler obeys the device-asserted occupancy', () => {
  it('a full yard holds the train at the throat; freeing a slot admits it', async () => {
    // A 2-slot railyard owning the M3 throat. Its device_registered + initial
    // zone_state_changed flow through the bridge → server → scheduler.
    const yard = simulation.spawnRailyard('YARD-1', 'M3', 2);
    await harness.testClient.waitForState('railway/state/devices/YARD-1');

    // Fill both slots BEFORE the train has any clearance toward M3. The yard
    // asserts occupancy 2/2 — full — and the gates_zone capability will veto
    // clearance to M3. (A slot could equally be a cut of carriages; core can't
    // tell, and doesn't need to.)
    yard.fillToCapacity();
    await waitForOccupancy('YARD-1', 2);

    // Spawn the train and route it through the throat. It declares core.can_reverse
    // (ADR-027) — a prerequisite for zone admission.
    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      config: { can_reverse: true },
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    harness.server.assignSchedule('T1', 'yard-route', ['M1', 'M3']);

    // The train receives clearance up to M2 (before the throat) but no further.
    await harness.testClient.waitForCommand('T1', 'grant_clearance');
    const firstGrant = grantsFor('T1')[0];
    expect((firstGrant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');

    // Advance: the train rolls to M2 and stops at the clearance limit.
    const heldDeadline = Date.now() + 4000;
    while (Date.now() < heldDeadline) {
      simulation.advance(50);
      await new Promise((r) => setTimeout(r, 5));
      if (grantsFor('T1').length >= 2) break;
    }
    await new Promise((r) => setTimeout(r, 300));

    // While the yard is full, no clearance into the throat (M3) is granted.
    expect(m3GrantsFor('T1')).toHaveLength(0);

    // A consist leaves the yard: one slot frees (occupancy 1/2). The yard emits
    // zone_state_changed; the scheduler re-consults and admits the held train.
    yard.vacate();
    await waitForOccupancy('YARD-1', 1);

    const admitDeadline = Date.now() + 4000;
    while (Date.now() < admitDeadline) {
      simulation.advance(50);
      await new Promise((r) => setTimeout(r, 5));
      if (m3GrantsFor('T1').length > 0) break;
    }

    expect(m3GrantsFor('T1').length).toBeGreaterThanOrEqual(1);
  });

  it('reconciles a train length on its way out of the yard (ADR-023)', async () => {
    // The yard swallows a train of one length and emits another: a 250 mm train
    // enters, the yard rearranges its carriages, and reports it out at 100 mm.
    const yard = simulation.spawnRailyard('YARD-1', 'M3', 2); // room to admit
    await harness.testClient.waitForState('railway/state/devices/YARD-1');

    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      config: { length_mm: 250 },
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    const lengthOf = () =>
      (
        harness.testClient.retained().get('railway/state/devices/T1') as {
          train_length_mm?: number;
        }
      )?.train_length_mm;
    expect(lengthOf()).toBe(250);

    // The railyard reports the train out at a shorter length (a carriage was
    // dropped inside). It is honoured because the yard declared
    // core.reports_length — the train itself is unaware.
    yard.reportTrainLength('T1', 100);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      if (lengthOf() === 100) break;
    }
    expect(lengthOf()).toBe(100);
  });

  it('refuses to admit a train that cannot reverse (ADR-027)', async () => {
    simulation.spawnRailyard('YARD-1', 'M3', 2); // room to admit
    await harness.testClient.waitForState('railway/state/devices/YARD-1');

    // A train that does NOT declare core.can_reverse. Interior shunting needs
    // reversing, so the scheduler must refuse it admission into the yard.
    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    harness.server.assignSchedule('T1', 'yard-route', ['M1', 'M3']);

    // Let the route attempt settle. The train is never cleared toward the throat,
    // and the scheduler warns.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      simulation.advance(50);
      await new Promise((r) => setTimeout(r, 10));
      const refused = harness.testClient
        .events()
        .some(
          (e) => e.event_type === 'anomaly' && JSON.stringify(e.payload).includes('can_reverse'),
        );
      if (refused) break;
    }

    expect(m3GrantsFor('T1')).toHaveLength(0);
    const anomaly = harness.testClient
      .events()
      .find((e) => e.event_type === 'anomaly' && JSON.stringify(e.payload).includes('can_reverse'));
    expect(anomaly).toBeDefined();
  });
});
