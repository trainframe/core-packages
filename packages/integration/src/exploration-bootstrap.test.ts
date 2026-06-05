import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation } from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * The cold-start discovery bootstrap (ADR-015), end-to-end through real seams:
 * a real `Server` (in discovery — no edges), a real `Simulation` train bridged
 * to the same broker, and the operator's *Learn track* gesture. We drive no
 * train physics by hand: the operator presses one button, the train explores
 * itself, and we observe the server's layout fill in. This is the deadlock
 * ADR-014 named — and could not break — finally breaking.
 */

const RING: Layout = {
  name: 'ring',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'block_boundary' },
    { id: 'M4', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 171 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 171 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 171 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 171 },
  ],
  junctions: [],
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let harness: Harness;
let simClient: MqttBrokerClient;
let sim: Simulation;
let bridge: BrokerBridge;

beforeEach(async () => {
  // Server boots in pure discovery: it knows no markers and no edges.
  harness = await startHarness({ layout: { name: 'ring', markers: [], edges: [], junctions: [] } });
  simClient = new MqttBrokerClient();
  await simClient.connect(harness.brokerUrl);
  // The sim holds the *physical* ring (the rails the train rolls on).
  sim = new Simulation({ layout: RING, seed: 1 });
  sim.seedIdentityTags(RING);
  bridge = new BrokerBridge(sim, simClient, { newId: () => randomUUID() });
  bridge.start();
});

afterEach(async () => {
  bridge.stop();
  await simClient.disconnect();
  await harness.shutdown();
});

describe('Cold-start discovery via exploration (ADR-015)', () => {
  it('learns every edge of a fresh loop from one Learn-track press', async () => {
    // Operator commissions the markers, exactly as the toy-table scan does
    // through the synthetic GARAGE device.
    await harness.testClient.publishEvent('device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    for (const marker of RING.markers) {
      await harness.testClient.publishEvent('tag_assignment', 'GARAGE', {
        tag_id: marker.id,
        assigned_kind: 'marker',
        target_id: marker.id,
        marker_kind: marker.kind,
      });
    }
    await harness.testClient.waitForState('railway/state/tags/M4');

    // Power the train onto the ring; the bridge announces it and reports the
    // marker it sits on.
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    await harness.testClient.waitForState('railway/state/devices/T1');
    await delay(100); // let the spawn tag_observed reach the scheduler

    // The deadlock precondition: markers known, not one edge.
    expect(harness.server.getLayoutState().findEdge('M1', 'M2')).toBeUndefined();

    // The single operator gesture.
    await harness.testClient.publishOperator('learn_track_start', {});

    // Pump sim time forward; the train explores autonomously and the server
    // learns the graph from the traversals it reports — we route nothing.
    await expect
      .poll(
        async () => {
          sim.advance(150);
          await delay(15);
          return RING.edges.every(
            (e) =>
              harness.server.getLayoutState().findEdge(e.from_marker_id, e.to_marker_id) !==
              undefined,
          );
        },
        { timeout: 20_000, message: 'every ring edge learned via exploration' },
      )
      .toBe(true);

    // It was driven by one open exploration clearance, never routed edge-by-edge.
    const commands = harness.testClient.commandsFor('T1');
    expect(
      commands.filter((c) => c.command_type === 'begin_exploration').length,
    ).toBeGreaterThanOrEqual(1);
    expect(commands.filter((c) => c.command_type === 'assign_route')).toHaveLength(0);
  });
});
