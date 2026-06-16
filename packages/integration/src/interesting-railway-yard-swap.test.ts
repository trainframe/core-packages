/**
 * THE CARRIAGE-SWAP gate for the interesting railway — the heart of the 4-train stress
 * test (milestone 3). One train's schedule includes a YARD VISIT; the others keep
 * circulating. On the REAL stack (broker + `@trainframe/server` scheduler + the demo's
 * ONE physics world over MQTT) it asserts:
 *   - SWAP: the visiting train's carriages are EXCHANGED on-rail — it leaves the yard
 *     coupled to the stabled spares, having shed its own cut (which stays in the yard).
 *     The crane only ever decouples; nothing leaves the rails (the swap is the reused
 *     `YardController` over the parallelogram drive-through yard).
 *   - LIVENESS: the other three trains keep progressing throughout (the drive-through
 *     yard's bypass means a service never blocks the running line).
 *
 * Drives the system through events + observed world state; mocks nothing.
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
} from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const DT = 1 / 60;
const RUN_SECONDS = 320;

interface Rig {
  readonly harness: Harness;
  readonly demo: InterestingRailwayDemo;
  readonly clients: MqttBrokerClient[];
  advanceClock(ms: number): void;
  shutdown(): Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** The set of body ids coupled to `id` (its rake), by flood-fill over couplings. */
function rake(demo: InterestingRailwayDemo, id: string): Set<string> {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    for (const n of demo.world.coupledTo(cur))
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
  }
  return seen;
}

const segmentOf = (demo: InterestingRailwayDemo, id: string): string | undefined =>
  demo.world.bodies().find((b) => b.id === id)?.segment;

/** Has T1's rake become loco + spares (its own cut shed)? */
function isSwapped(demo: InterestingRailwayDemo, originalCut: string[], spares: string[]): boolean {
  const t1 = rake(demo, 'T1');
  return spares.every((s) => t1.has(s)) && originalCut.every((c) => !t1.has(c));
}

/** Pump `RUN_SECONDS` of sim time; track each train's distinct markers and whether T1's
 *  swap ever completed. */
async function pump(
  rig: Rig,
  originalCut: string[],
  spares: string[],
): Promise<{ swapped: boolean; markerSets: Map<string, Set<string>> }> {
  const markerSets = new Map(rig.demo.trainIds.map((id) => [id, new Set<string>()]));
  const batches = Math.ceil(RUN_SECONDS / DT / 12);
  let swapped = false;
  for (let i = 0; i < batches; i++) {
    for (let t = 0; t < 12; t++) {
      rig.demo.step(DT);
      rig.advanceClock(DT * 1000);
    }
    await delay(4);
    for (const e of rig.harness.testClient.events()) {
      if (e.event_type !== 'tag_observed') continue;
      markerSets.get(e.device_id)?.add((e.payload as { tag_id: string }).tag_id);
    }
    if (isSwapped(rig.demo, originalCut, spares)) swapped = true;
  }
  return { swapped, markerSets };
}

describe('Interesting-railway scheduled YARD VISIT swaps a train’s carriages on-rail', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig(interestingToLayout(buildMainLoopScene()));
  });

  afterEach(async () => {
    await rig.shutdown();
  });

  it('the visiting train leaves with the spares, sheds its own cut, others keep running', async () => {
    /* T1 gets a YARD-VISIT schedule (its leg terminates at the yard throat — the zone
     *  services it); the other three keep their default circulation rotas. */
    rig.harness.server.assignSchedule('T1', 'r1-yard', [M.north, M.east, M.yard, M.south]);
    for (const id of ['T2', 'T3', 'T4']) {
      const route = rig.demo.routes.get(id);
      if (route === undefined) throw new Error(`no route for ${id}`);
      rig.harness.server.assignSchedule(id, route.routeId, [...route.stops]);
    }

    /* T1's original cut + the stabled spares, before the swap. */
    const originalCut = ['T1-c0', 'T1-c1'];
    const spares = ['spare0', 'spare1'];

    const { swapped, markerSets } = await pump(rig, originalCut, spares);

    /* THE SWAP: T1 now hauls the spares, not its own cut. */
    const t1Rake = rake(rig.demo, 'T1');
    expect(swapped, 'T1 picked up the spares at some point').toBe(true);
    expect([...t1Rake].sort(), 'T1 departs with loco + spares').toEqual(
      ['T1', 'spare0', 'spare1'].sort(),
    );
    for (const c of originalCut) expect(t1Rake.has(c), `${c} shed`).toBe(false);
    /* The shed cut stays coupled to itself, abandoned in the yard interior. */
    expect(rake(rig.demo, 'T1-c0').has('T1-c1'), 'shed cut stays coupled').toBe(true);
    const shedSeg = segmentOf(rig.demo, 'T1-c0');
    expect(shedSeg?.startsWith('yard-'), `shed cut parked in the yard (was ${shedSeg})`).toBe(true);

    /* LIVENESS: the other three kept circulating throughout the service. */
    for (const id of ['T2', 'T3', 'T4']) {
      expect(markerSets.get(id)?.size ?? 0, `${id} kept progressing`).toBeGreaterThanOrEqual(6);
    }
  }, 180_000);
});
