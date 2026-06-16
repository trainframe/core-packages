/**
 * THE SPARES-ROTATION gate for the interesting railway's yard (milestone 3, multi-visit).
 * The yard has no inexhaustible store of spares: each serviced train leaves its OWN shed
 * cut behind in its slot, and THAT cut becomes the next visitor's spares. So a wagon
 * migrates down a chain of trains, visit after visit, and every slot gets used.
 *
 * On the REAL stack it services two trains in sequence and asserts:
 *   - Visit 1: T1 leaves coupled to the INITIAL spares, shedding its own cut into a slot.
 *   - Visit 2: T2 leaves coupled to T1'S SHED CUT (the rotated spares) — train→train
 *     migration — shedding its own cut into a DIFFERENT slot.
 * Drives the system through events + observed couplings; mocks nothing.
 */
import type { Layout } from '@trainframe/protocol';
import {
  type InterestingRailwayDemo,
  INTERESTING_MARKERS as M,
  MqttBrokerClient,
  buildInterestingRailwayDemo,
  buildMainLoopScene,
  interestingToLayout,
  mqttPlatform,
} from '@trainframe/simulator-ui/demo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const DT = 1 / 60;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Rig {
  readonly harness: Harness;
  readonly demo: InterestingRailwayDemo;
  readonly clients: MqttBrokerClient[];
  advanceClock(ms: number): void;
  shutdown(): Promise<void>;
}

async function startRig(layout: Layout): Promise<Rig> {
  let clockMs = 0;
  const harness = await startHarness({ layout, now: () => clockMs });
  await harness.testClient.seedIdentityTags(layout.markers.map((m) => m.id));
  const clients: MqttBrokerClient[] = [];
  const demo = buildInterestingRailwayDemo((deviceId) => {
    const client = new MqttBrokerClient();
    clients.push(client);
    client.connect(harness.brokerUrl);
    return mqttPlatform(client, deviceId);
  });
  await delay(400);
  demo.start();
  for (const id of [...demo.trainIds, ...demo.switchDeviceIds, demo.yardDeviceId]) {
    await harness.testClient.waitForState(`railway/state/devices/${id}`);
  }
  return {
    harness,
    demo,
    clients,
    advanceClock: (ms) => {
      clockMs += ms;
    },
    shutdown: async () => {
      demo.stop();
      for (const c of clients) c.disconnect();
      await harness.shutdown();
    },
  };
}

function rake(demo: InterestingRailwayDemo, id: string): Set<string> {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    for (const n of demo.world.coupledTo(cur)) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

const segOf = (demo: InterestingRailwayDemo, id: string): string | undefined =>
  demo.world.bodies().find((b) => b.id === id)?.segment;

const releasedCount = (rig: Rig, trainId: string): number =>
  rig.harness.testClient
    .events()
    .filter(
      (e) =>
        e.event_type === 'zone_train_released' &&
        (e.payload as { train_id: string }).train_id === trainId,
    ).length;

/** Pump until `done()` (or a cap), in the fine-grained cadence the scheduler needs. */
async function pumpUntil(rig: Rig, done: () => boolean, capSeconds: number): Promise<boolean> {
  const batches = Math.ceil(capSeconds / DT / 12);
  for (let i = 0; i < batches; i++) {
    for (let t = 0; t < 12; t++) {
      rig.demo.step(DT);
      rig.advanceClock(DT * 1000);
    }
    await delay(4);
    if (done()) return true;
  }
  return false;
}

describe('Interesting-railway yard ROTATES spares: a wagon migrates down a chain of trains', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig(interestingToLayout(buildMainLoopScene()));
  });

  afterEach(async () => {
    await rig.shutdown();
  });

  it('T2 leaves wearing T1’s shed cut (rotated spares), into a different slot', async () => {
    /* Visit 1: T1 to the yard; the others circulate (no yard). */
    rig.harness.server.assignSchedule('T1', 'r1-yard', [M.north, M.east, M.yard, M.south]);
    for (const id of ['T2', 'T3', 'T4']) {
      const r = rig.demo.routes.get(id);
      if (r) rig.harness.server.assignSchedule(id, r.routeId, [...r.stops]);
    }
    expect(await pumpUntil(rig, () => releasedCount(rig, 'T1') >= 1, 260)).toBe(true);

    /* After visit 1: T1 wears the INITIAL spares; its own cut is shed into a slot. */
    const afterT1 = rake(rig.demo, 'T1');
    expect(afterT1.has('spare0') && afterT1.has('spare1'), 'T1 took the initial spares').toBe(true);
    expect(afterT1.has('T1-c0'), 'T1 shed its own cut').toBe(false);
    const t1CutSlot = segOf(rig.demo, 'T1-c0');
    expect(t1CutSlot?.startsWith('yard-'), 'T1 cut stabled in a yard slot').toBe(true);

    /* Now stop T1 returning, and send T2 in: it must pick up T1's cut, not phantom spares. */
    rig.harness.server.assignSchedule('T1', 'r1-loop', [M.north, M.east, M.south]);
    rig.harness.server.assignSchedule('T2', 'r2-yard', [M.north, M.east, M.yard, M.south]);
    expect(await pumpUntil(rig, () => releasedCount(rig, 'T2') >= 1, 320)).toBe(true);

    /* THE ROTATION: T2 leaves wearing T1's SHED CUT (train→train migration). */
    const afterT2 = rake(rig.demo, 'T2');
    expect(afterT2.has('T1-c0') && afterT2.has('T1-c1'), 'T2 picked up T1’s shed cut').toBe(true);
    expect(afterT2.has('T2-c0'), 'T2 shed its own cut').toBe(false);

    /* T2's cut stables in a DIFFERENT slot than T1's did (all slots usable). */
    const t2CutSlot = segOf(rig.demo, 'T2-c0');
    expect(t2CutSlot?.startsWith('yard-'), 'T2 cut stabled in a yard slot').toBe(true);
    expect(t2CutSlot, 'T2 used a different slot than T1').not.toBe(t1CutSlot);
  }, 220_000);
});
