import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation } from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * Gate hold/release: the operator sends `hold_gate` via `server.publishCommand`,
 * a real VirtualGate receives it through the BrokerBridge, emits
 * `gate_state_changed: withholding`, and the scheduler vetoes further clearance.
 * Releasing the gate via `release_gate` re-enables clearance extension.
 *
 * Using a real Simulation+BrokerBridge rather than TestClient-injected
 * `gate_state_changed` preserves the unique signal: the operator-command
 * round-trip (server → broker → gate → gate_state_changed → server → scheduler).
 * The pure clearance-flow tests already cover the direct injection path.
 *
 * Safety-critical regression: a held gate must prevent the train from crossing
 * the gated marker, and must unblock it promptly on release.
 */

const LOOP: Layout = {
  name: 'gate-hold-release',
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

describe('Operator hold/release gate: the scheduler obeys the gate state', () => {
  it('holding GATE-1 at M3 stops the train at M2; releasing lets it advance to M3', async () => {
    // Spawn a VirtualGate. Its device_registered event flows through the
    // bridge → server → scheduler, registering it with core.gates_clearance.
    simulation.spawnGate('GATE-1');
    await harness.testClient.waitForState('railway/state/devices/GATE-1');

    // Operator holds the gate at M3 BEFORE the train has any clearance past M2.
    // server.publishCommand sends hold_gate to railway/commands/GATE-1;
    // the bridge delivers it to VirtualGate.acceptCommand, which emits
    // gate_state_changed: withholding. The scheduler then vetoes clearance
    // extension at M3.
    harness.server.publishCommand('GATE-1', 'hold_gate', {
      marker_id: 'M3',
      reason: 'operator hold test',
    });
    /*
     * The hold is a broker round-trip; wait for the gate's withholding event
     * before assigning the route, or the scheduler can grant M3 first.
     * VirtualGate only emits gate_state_changed on transitions, so the first
     * event seen here is the withhold.
     */
    await harness.testClient.waitForEvent('gate_state_changed', 'GATE-1');

    // Spawn the train and assign a route through the gated marker.
    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    harness.server.assignSchedule('T1', 'gate-test-route', ['M1', 'M3']);

    // The train must receive the initial M2 clearance (before the gate).
    await harness.testClient.waitForCommand('T1', 'grant_clearance');
    const firstGrant = grantsFor('T1')[0];
    expect((firstGrant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');

    // Advance the train to M2 — it crosses M1 then arrives at the M2
    // clearance limit and stops. The bridge propagates tag_observed for each
    // marker the simulation crosses.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      simulation.advance(50);
      await new Promise((r) => setTimeout(r, 5));
      const grants = grantsFor('T1');
      // As long as the gate is still holding, no M3 grant should arrive.
      // Once the train stops at M2 the count stabilises at 1.
      if (grants.length >= 2) break;
    }

    // Give the broker a beat to deliver any in-flight messages.
    await new Promise((r) => setTimeout(r, 300));

    // While the gate is withholding M3, no further clearance past M2 is granted.
    const grantsWhileHeld = grantsFor('T1').filter(
      (c) => (c.payload as { limit_marker_id: string }).limit_marker_id === 'M3',
    );
    expect(grantsWhileHeld).toHaveLength(0);

    // Release the gate. The VirtualGate emits gate_state_changed: granting,
    // and the scheduler re-evaluates pending clearance for T1.
    harness.server.publishCommand('GATE-1', 'release_gate', { marker_id: 'M3' });

    // After release the train must receive the M3 clearance.
    const releaseDeadline = Date.now() + 4000;
    while (Date.now() < releaseDeadline) {
      simulation.advance(50);
      await new Promise((r) => setTimeout(r, 5));
      const m3Grants = grantsFor('T1').filter(
        (c) => (c.payload as { limit_marker_id: string }).limit_marker_id === 'M3',
      );
      if (m3Grants.length > 0) break;
    }

    const m3Grants = grantsFor('T1').filter(
      (c) => (c.payload as { limit_marker_id: string }).limit_marker_id === 'M3',
    );
    expect(m3Grants.length).toBeGreaterThanOrEqual(1);
  });
});
