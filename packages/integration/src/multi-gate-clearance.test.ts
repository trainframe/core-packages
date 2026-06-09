import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation } from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * Multi-gate semantics (ADR-018): when several gates_clearance devices gate the
 * same marker, clearance across that marker is conjunctive AND — a train is
 * cleared only when EVERY gate grants, and a single withhold is an absolute
 * veto no peer's grant can cancel.
 *
 * `gate-hold-release.test.ts` locks the n=1 case. This file locks n>1. Two real
 * VirtualGates both withhold M3 through the BrokerBridge; the scheduler folds
 * their onClearanceConsultation votes (veto-on-any-deny) and must hold the train
 * at M2 until BOTH release.
 *
 * The discriminating assertion — the one that distinguishes conjunctive AND from
 * a single-gate veto — is the middle step: after releasing ONE gate, the
 * scheduler re-evaluates (the release fires retryBlockedClearances) with the
 * OTHER gate's deny still standing, and clearance must STILL be withheld. The
 * final release is the positive control proving the block was real and the grant
 * path is live.
 */

const LOOP: Layout = {
  name: 'multi-gate-clearance',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'block_boundary' },
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

/** Drive the sim/broker for up to `budget_ms`, stopping early when `done()`. */
async function pump(budget_ms: number, done: () => boolean): Promise<void> {
  const deadline = Date.now() + budget_ms;
  while (Date.now() < deadline) {
    simulation.advance(50);
    await new Promise((r) => setTimeout(r, 5));
    if (done()) return;
  }
}

describe('Multi-gate clearance is conjunctive AND (ADR-018)', () => {
  it('two gates on M3: train held until BOTH release; releasing one alone keeps it held', async () => {
    // Two independent gating devices, each gating the SAME marker M3 for its own
    // reason. Both register via the bridge → server → scheduler with
    // core.gates_clearance.
    const gateA = simulation.spawnGate('GATE-A');
    const gateB = simulation.spawnGate('GATE-B');
    await harness.testClient.waitForState('railway/state/devices/GATE-A');
    await harness.testClient.waitForState('railway/state/devices/GATE-B');

    // Both withhold M3 BEFORE the train has any clearance past M2.
    gateA.withhold('M3', 'gate A reason');
    gateB.withhold('M3', 'gate B reason');

    // Wait for BOTH withholds to round-trip before assigning the schedule, or
    // the scheduler can grant M3 before the second withhold lands (flaky pass).
    await harness.testClient.waitForEvent('gate_state_changed', 'GATE-A');
    await harness.testClient.waitForEvent('gate_state_changed', 'GATE-B');

    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    harness.server.assignSchedule('T1', 'multi-gate-route', ['M1', 'M3']);

    // The train must receive the initial M2 clearance (before the gated marker).
    await harness.testClient.waitForCommand('T1', 'grant_clearance');
    const firstGrant = grantsFor('T1')[0];
    expect((firstGrant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');

    // Advance the train to M2; with both gates holding, no M3 grant may arrive.
    await pump(4000, () => grantsFor('T1').length >= 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(m3GrantsFor('T1')).toHaveLength(0);

    // Release ONE gate. Its granting event fires retryBlockedClearances, so the
    // scheduler genuinely re-runs the fold — but GATE-B's deny still stands.
    // Under conjunctive AND the train must STILL be held. (Under a broken
    // OR/priority fold, one grant would un-veto the peer and M3 would clear.)
    harness.server.publishCommand('GATE-A', 'release_gate', { marker_id: 'M3' });
    await pump(2000, () => m3GrantsFor('T1').length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(m3GrantsFor('T1')).toHaveLength(0); // discriminating: AND, not OR

    // Release the SECOND gate. Now no gate withholds M3, so clearance extends.
    // This positive control proves the block above was real and the grant path
    // is live (not merely "the grant hadn't arrived yet").
    harness.server.publishCommand('GATE-B', 'release_gate', { marker_id: 'M3' });
    await pump(4000, () => m3GrantsFor('T1').length > 0);
    expect(m3GrantsFor('T1').length).toBeGreaterThanOrEqual(1);
  });

  it('disconnect composes: a gate vanishing mid-withhold drops only its own veto', async () => {
    // "Disconnect composes cleanly" (ADR-018 Consequences): a gate's
    // onDeviceDisconnect releases only THAT device's withholds. With a peer
    // still holding the same marker under AND, the train stays held.
    const gateA = simulation.spawnGate('GATE-A');
    const gateB = simulation.spawnGate('GATE-B');
    await harness.testClient.waitForState('railway/state/devices/GATE-A');
    await harness.testClient.waitForState('railway/state/devices/GATE-B');

    gateA.withhold('M3', 'gate A reason');
    gateB.withhold('M3', 'gate B reason');
    await harness.testClient.waitForEvent('gate_state_changed', 'GATE-A');
    await harness.testClient.waitForEvent('gate_state_changed', 'GATE-B');

    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    harness.server.assignSchedule('T1', 'multi-gate-route', ['M1', 'M3']);

    await harness.testClient.waitForCommand('T1', 'grant_clearance');
    await pump(4000, () => grantsFor('T1').length >= 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(m3GrantsFor('T1')).toHaveLength(0);

    // GATE-A vanishes. Its disconnect hook releases ONLY its own withhold; the
    // server re-evaluates clearance, but GATE-B's deny survives → still held.
    simulation.despawnGate('GATE-A');
    await pump(2000, () => m3GrantsFor('T1').length > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(m3GrantsFor('T1')).toHaveLength(0); // peer veto outlives the vanished gate

    // Release the surviving gate → clearance extends (positive control).
    harness.server.publishCommand('GATE-B', 'release_gate', { marker_id: 'M3' });
    await pump(4000, () => m3GrantsFor('T1').length > 0);
    expect(m3GrantsFor('T1').length).toBeGreaterThanOrEqual(1);
  });
});
