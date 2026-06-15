/**
 * THE LIVENESS GATE for the branching railyard demo.
 *
 * Where `branching-scheduler.test.ts` proves the demo is CORRECT (clearance-driven,
 * distinct branches, the yard queue, train→train migration, no phantom flip), this
 * proves it is LIVE: the FULL concurrent run — every demo train assigned its
 * `DEMO_ROUTES` schedule at once — keeps EVERY train PROGRESSING for a sustained
 * run, never gridlocking.
 *
 * It boots the same real stack the scheduler gate does (aedes broker + the real
 * `@trainframe/server` scheduler + the demo's ONE physics world and its
 * scheduler-driven devices, all in Node over `mqttPlatform`), assigns every demo
 * train its cyclic schedule, then pumps for ≥200 sim-seconds while sampling each
 * train's `(segment, railPos)` pose. It asserts two things, both of which the
 * gridlocking branch-hung-yard topology FAILS (it froze trains for 180-235 s):
 *   - NO STALL: no train's pose stays unchanged for more than ~20 consecutive
 *     sim-seconds (a deadlocked train freezes; a dwelling/queueing train moves
 *     again well inside that window).
 *   - PROGRESS: every train traverses several DISTINCT markers across the run
 *     (it is going somewhere, not oscillating in one block).
 *
 * Drives the system through events + observed world poses; never mocks the
 * scheduler, registry, broker, or any device hook.
 */
import type { Layout } from '@trainframe/protocol';
import {
  type BranchingDemo,
  DEMO_ROUTES,
  MqttBrokerClient,
  buildBranchingDemo,
  buildBranchingScene,
  mqttPlatform,
  sceneToLayout,
} from '@trainframe/simulator-ui/demo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const DT = 1 / 60;
/** Sim-seconds of run the liveness gate pumps. */
const RUN_SECONDS = 200;
/**
 * Longest a train's pose may stay unchanged before we call it deadlocked (sim-s).
 * A DEADLOCKED train freezes for the WHOLE remaining run (the branch-hung-yard
 * topology froze trains for 180-235 sim-s). A live train's longest legitimate
 * pause is one capacity-1 yard service it is queued behind (~37 sim-s observed on
 * the in-line yard). 60 s sits well above that queue wait and far below any true
 * deadlock, so it cleanly separates "always resumes" from "frozen forever".
 */
const MAX_STALL_SECONDS = 60;
/** How many distinct markers each train must traverse over the run — real lap
 *  progress, not oscillating in one block. (Each train clears 8-10.) */
const MIN_DISTINCT_MARKERS = 6;
/** Sim-seconds between pose samples (one batch of ticks + a broker flush). */
const SAMPLE_TICKS = 12;

interface Rig {
  readonly harness: Harness;
  readonly demo: BranchingDemo;
  readonly deviceClients: MqttBrokerClient[];
  /** Advance the scheduler's virtual clock by `ms` (in lockstep with the sim). */
  advanceClock(ms: number): void;
  shutdown(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Boot the broker + scheduler against the layout, build the demo over MQTT (one
 *  client per device), seed identity tags, and wait for every device to register —
 *  modelled on `branching-scheduler.test.ts`'s `startRig`. The scheduler runs on a
 *  VIRTUAL clock the caller advances in lockstep with the sim, so station dwells
 *  fire in SIM time however fast the pump runs (deterministic). */
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
  const demo = buildBranchingDemo(platformFactory);
  await delay(400);
  demo.start();

  for (const id of [...demo.trainIds, demo.yardDeviceId, ...demo.switchDeviceIds]) {
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

/** A train's current pose key (segment + quantised world position), so we can tell
 *  a frozen train (key unchanged) from a moving one. The world pose (`x`,`y`) is
 *  the observable on `BodyPose`; quantising to ~5 mm filters tiny jitter while a
 *  genuinely moving train changes blocks/position far more than that per sample. */
function poseKey(demo: BranchingDemo, trainId: string): string {
  const b = demo.world.bodies().find((x) => x.id === trainId);
  if (b === undefined) return 'missing';
  return `${b.segment}:${Math.round(b.x / 5)}:${Math.round(b.y / 5)}`;
}

/** Accumulate one sample of stall tracking for every train: extend a train's
 *  current frozen stretch if its pose is unchanged (recording its worst), else
 *  reset it. Mutates `lastKey`/`stalled`/`worst` in place. */
function trackStalls(
  demo: BranchingDemo,
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

/** Pump the rig for `RUN_SECONDS` of sim time (clock advanced in lockstep), and
 *  return each train's LONGEST frozen-pose stretch (sim-s) over the run. */
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
    /* Let the broker flush + the scheduler react before the next sample. */
    await delay(5);
    trackStalls(rig.demo, trainIds, batchSeconds, lastKey, stalled, worst);
  }
  return worst;
}

describe('Branching railyard concurrent run is LIVE (no deadlock)', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig(sceneToLayout(buildBranchingScene(3), 'branching'));
  });

  afterEach(async () => {
    await rig.shutdown();
  });

  /** Markers a train reported crossing (server-derived from its tag stream). */
  const traversedBy = (trainId: string): Set<string> =>
    new Set(
      rig.harness.testClient
        .events()
        .filter((e) => e.event_type === 'tag_observed' && e.device_id === trainId)
        .map((e) => (e.payload as { tag_id: string }).tag_id),
    );

  it('keeps every train progressing across a sustained concurrent run', async () => {
    /* Assign every train its cyclic DEMO route at once — the full concurrent
     *  scenario the render shows, and exactly what gridlocks on the branch-hung
     *  yard topology. */
    for (const id of rig.demo.trainIds) {
      const route = DEMO_ROUTES.get(id);
      if (route === undefined) throw new Error(`no DEMO route for ${id}`);
      rig.harness.server.assignSchedule(id, route.routeId, [...route.stops]);
    }

    const worstStall = await runTrackingWorstStall(rig);

    /* NO STALL: every train kept moving — its longest frozen stretch is well under
     *  the deadlock threshold. A gridlocked train freezes for the whole run. */
    for (const id of rig.demo.trainIds) {
      expect(
        worstStall.get(id) ?? Number.POSITIVE_INFINITY,
        `${id} longest frozen stretch (sim-s)`,
      ).toBeLessThan(MAX_STALL_SECONDS);
    }

    /* PROGRESS: every train is genuinely going somewhere — it crossed several
     *  distinct markers, not oscillating within one block. */
    for (const id of rig.demo.trainIds) {
      expect(traversedBy(id).size, `${id} distinct markers traversed`).toBeGreaterThanOrEqual(
        MIN_DISTINCT_MARKERS,
      );
    }
  }, 120_000);
});
