/**
 * THE LIVENESS GATE for the 4-train interesting-railway demo — the stress test's
 * deadlock proof.
 *
 * It boots the SAME real stack the branching gate does (aedes broker + the real
 * `@trainframe/server` scheduler + the demo's ONE physics world and its
 * scheduler-driven devices, all in Node over `mqttPlatform`), assigns every one of the
 * FOUR trains its cyclic station rota at once, then pumps for a sustained run while
 * sampling each train's `(segment, world pose)`. It asserts:
 *   - NO STALL: no train's pose stays frozen for more than ~60 consecutive sim-seconds
 *     (a deadlocked train freezes forever; a dwelling/queueing one resumes well inside
 *     that window).
 *   - PROGRESS: every train traverses several DISTINCT markers across the run (going
 *     somewhere, not oscillating in one block).
 *
 * The drive-through yard's bypass is what makes four trains live where the branching
 * demo's in-line yard gridlocked a fourth: the running line is never blocked by a yard
 * service. Drives the system through events + observed poses; mocks nothing.
 */
import type { Layout } from '@trainframe/protocol';
import {
  type InterestingRailwayDemo,
  MqttBrokerClient,
  buildInterestingRailwayDemo,
  buildMainLoopScene,
  interestingToLayout,
  mqttPlatform,
} from '@trainframe/simulator-ui/demo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const DT = 1 / 60;
const RUN_SECONDS = 200;
const MAX_STALL_SECONDS = 60;
const MIN_DISTINCT_MARKERS = 6;
const SAMPLE_TICKS = 12;

interface Rig {
  readonly harness: Harness;
  readonly demo: InterestingRailwayDemo;
  readonly deviceClients: MqttBrokerClient[];
  advanceClock(ms: number): void;
  shutdown(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Boot the broker + scheduler against the layout, build the demo over MQTT (one
 *  client per device), seed identity tags, and wait for every device to register. The
 *  scheduler runs on a VIRTUAL clock the caller advances in lockstep with the sim. */
async function startRig(layout: Layout): Promise<Rig> {
  let clockMs = 0;
  const harness = await startHarness({ layout, now: () => clockMs });
  await harness.testClient.seedIdentityTags(layout.markers.map((m) => m.id));

  const deviceClients: MqttBrokerClient[] = [];
  const platformFactory = (deviceId: string) => {
    const client = new MqttBrokerClient();
    deviceClients.push(client);
    client.connect(harness.brokerUrl);
    return mqttPlatform(client, deviceId);
  };
  const demo = buildInterestingRailwayDemo(platformFactory);
  await delay(400);
  demo.start();

  for (const id of [...demo.trainIds, ...demo.switchDeviceIds]) {
    await harness.testClient.waitForState(`railway/state/devices/${id}`);
  }

  return {
    harness,
    demo,
    deviceClients,
    advanceClock(ms: number) {
      clockMs += ms;
    },
    async shutdown() {
      demo.stop();
      for (const c of deviceClients) c.disconnect();
      await harness.shutdown();
    },
  };
}

/** A train's pose key (segment + quantised world position) — frozen if unchanged. */
function poseKey(demo: InterestingRailwayDemo, trainId: string): string {
  const b = demo.world.bodies().find((x) => x.id === trainId);
  if (b === undefined) return 'missing';
  return `${b.segment}:${Math.round(b.x / 5)}:${Math.round(b.y / 5)}`;
}

/** Extend each train's frozen stretch if its pose is unchanged (recording its worst),
 *  else reset it. */
function trackStalls(
  demo: InterestingRailwayDemo,
  trainIds: readonly string[],
  batchSeconds: number,
  lastKey: Map<string, string>,
  stalled: Map<string, number>,
  worst: Map<string, number>,
): void {
  for (const id of trainIds) {
    const key = poseKey(demo, id);
    if (key === lastKey.get(id)) {
      const next = (stalled.get(id) ?? 0) + batchSeconds;
      stalled.set(id, next);
      if (next > (worst.get(id) ?? 0)) worst.set(id, next);
    } else {
      stalled.set(id, 0);
      lastKey.set(id, key);
    }
  }
}

/** Pump for `RUN_SECONDS` of sim time, returning each train's LONGEST frozen stretch. */
async function runTrackingWorstStall(rig: Rig): Promise<Map<string, number>> {
  const trainIds = [...rig.demo.trainIds];
  const lastKey = new Map<string, string>(trainIds.map((id) => [id, poseKey(rig.demo, id)]));
  const stalled = new Map<string, number>(trainIds.map((id) => [id, 0]));
  const worst = new Map<string, number>(trainIds.map((id) => [id, 0]));
  const batchSeconds = SAMPLE_TICKS * DT;
  const batches = Math.ceil(RUN_SECONDS / batchSeconds);
  for (let i = 0; i < batches; i++) {
    for (let t = 0; t < SAMPLE_TICKS; t++) {
      rig.demo.step(DT);
      rig.advanceClock(DT * 1000);
    }
    await delay(5);
    trackStalls(rig.demo, trainIds, batchSeconds, lastKey, stalled, worst);
  }
  return worst;
}

describe('Interesting-railway 4-train concurrent run is LIVE (no deadlock)', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig(interestingToLayout(buildMainLoopScene()));
  });

  afterEach(async () => {
    await rig.shutdown();
  });

  const traversedBy = (trainId: string): Set<string> =>
    new Set(
      rig.harness.testClient
        .events()
        .filter((e) => e.event_type === 'tag_observed' && e.device_id === trainId)
        .map((e) => (e.payload as { tag_id: string }).tag_id),
    );

  it('keeps all four trains progressing across a sustained concurrent run', async () => {
    for (const id of rig.demo.trainIds) {
      const route = rig.demo.routes.get(id);
      if (route === undefined) throw new Error(`no route for ${id}`);
      rig.harness.server.assignSchedule(id, route.routeId, [...route.stops]);
    }

    const worstStall = await runTrackingWorstStall(rig);

    for (const id of rig.demo.trainIds) {
      expect(
        worstStall.get(id) ?? Number.POSITIVE_INFINITY,
        `${id} longest frozen stretch (sim-s)`,
      ).toBeLessThan(MAX_STALL_SECONDS);
    }
    for (const id of rig.demo.trainIds) {
      expect(traversedBy(id).size, `${id} distinct markers traversed`).toBeGreaterThanOrEqual(
        MIN_DISTINCT_MARKERS,
      );
    }
  }, 120_000);
});
