import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation } from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * Station dwell: a train approaching a `station_stop` marker that has a
 * withholding gate pauses there. The train's `train_status` events must show
 * `speed_normalised = 0` for consecutive samples while the gate withholds.
 *
 * The dwell is gate-driven, not intrinsic to the `station_stop` marker kind:
 * a VirtualGate registered at M3 withholds clearance there, so the scheduler
 * vetoes the M2→M3 edge extension. The train stops at M2 (its clearance limit)
 * and emits `train_status` with speed_normalised = 0 until the gate releases.
 *
 * Uses a real Simulation+BrokerBridge so the train genuinely responds to
 * commands and emits `train_status` events as a real device would.
 */

const STATION_LOOP: Layout = {
  name: 'station-dwell',
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
  harness = await startHarness({ layout: STATION_LOOP });
  await harness.testClient.seedIdentityTags(['M1', 'M2', 'M3', 'M4']);

  simulation = new Simulation({ layout: STATION_LOOP, seed: 1 });
  simulation.seedIdentityTags(STATION_LOOP);

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

describe('Station dwell: gate-withheld station_stop marker pauses the train', () => {
  it('the train emits consecutive speed_normalised=0 train_status samples while gate withholds M3', async () => {
    // Spawn and hold the gate at the station marker before the train has
    // any clearance past M2. The scheduler will veto the M2→M3 extension,
    // leaving the train parked at M2 with speed = 0.
    simulation.spawnGate('GATE-M3');
    await harness.testClient.waitForState('railway/state/devices/GATE-M3');

    harness.server.publishCommand('GATE-M3', 'hold_gate', {
      marker_id: 'M3',
      reason: 'station dwell test',
    });

    // Spawn the train and assign a cyclic route through the station marker.
    simulation.spawnTrain('T1', {
      startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' },
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    harness.server.assignSchedule('T1', 'station-route', ['M1', 'M3']);

    // Advance the simulation until we observe at least two consecutive
    // train_status events for T1 with speed_normalised = 0, preceded by at
    // least one nonzero sample (confirming the train actually started moving
    // before dwelling, not just idling at spawn before clearance arrived).
    // The VirtualTrain emits train_status every 250 ms of sim time;
    // we advance in 50 ms steps and allow up to 6 s wall-clock.
    let consecutiveZero = 0;
    let hasMoved = false;
    const deadline = Date.now() + 6000;

    while (Date.now() < deadline) {
      simulation.advance(50);
      await new Promise((r) => setTimeout(r, 5));

      // Count consecutive zero-speed samples from the tail of the event list.
      const statusEvents = harness.testClient
        .events()
        .filter((e) => e.event_type === 'train_status' && e.device_id === 'T1');

      // Walk backwards counting consecutive zeros.
      let count = 0;
      for (let i = statusEvents.length - 1; i >= 0; i--) {
        const speed = (statusEvents[i]?.payload as { speed_normalised?: number }).speed_normalised;
        if (speed === 0) {
          count += 1;
        } else {
          // Non-zero sample: the train has genuinely been moving.
          hasMoved = true;
          break;
        }
      }
      consecutiveZero = count;
      if (hasMoved && consecutiveZero >= 2) break;
    }

    // The train must have been observed moving at some point before dwelling —
    // spawn-rest zeros (before the first grant_clearance arrives) do not count.
    expect(hasMoved).toBe(true);
    expect(consecutiveZero).toBeGreaterThanOrEqual(2);
  });
});
