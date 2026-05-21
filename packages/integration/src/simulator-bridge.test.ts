import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation } from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const SIMPLE_LOOP: Layout = {
  name: 'simple-loop-sim-bridge',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
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
  harness = await startHarness({ layout: SIMPLE_LOOP });
  // Seed tag bindings on the *server* side. The simulator (device-only mode)
  // emits tag_observed events; the server resolves them through its own
  // TagRegistry, so the assignment events must reach the server.
  await harness.testClient.seedIdentityTags(['M1', 'M2', 'M3', 'M4']);

  // Pass the same identity mapping to the simulation so its VirtualTrains
  // know which tag_id to emit per marker. No tag_assignment events fire on
  // construction here - the harness already populated the server.
  simulation = new Simulation({
    layout: SIMPLE_LOOP,
    seed: 1,
    disableScheduler: true,
    register_tags: 'identity',
  });

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

describe('BrokerBridge: simulator runs in device-only mode against a real server', () => {
  it('forwards device events from the simulation to the server and routes server commands back', async () => {
    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });

    await harness.testClient.waitForState('railway/state/devices/T1');

    harness.server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    const grant = await harness.testClient.waitForCommand('T1', 'grant_clearance');
    expect((grant.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');

    const startCommands = simulation.commands.length;
    const start = Date.now();
    while (simulation.commands.length === startCommands && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const commandTypes = simulation.commands.map((c) => c.event_type);
    expect(commandTypes).toContain('assign_route');
    expect(commandTypes).toContain('grant_clearance');
  });

  it('drives the train through the route end-to-end: sim emits tag_observed, server extends clearance', async () => {
    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    harness.server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    await harness.testClient.waitForCommand('T1', 'grant_clearance');

    // Let the train run. Track ticks long enough for at least one marker
    // crossing + detection latency + a round trip through the broker.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      simulation.advance(100);
      await new Promise((r) => setTimeout(r, 10));
      const grants = harness.testClient
        .commandsFor('T1')
        .filter((c) => c.command_type === 'grant_clearance')
        .map((c) => (c.payload as { limit_marker_id: string }).limit_marker_id);
      if (grants.includes('M3')) break;
    }

    const grants = harness.testClient
      .commandsFor('T1')
      .filter((c) => c.command_type === 'grant_clearance')
      .map((c) => (c.payload as { limit_marker_id: string }).limit_marker_id);
    expect(grants).toContain('M2');
    expect(grants).toContain('M3');
  });
});
