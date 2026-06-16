/**
 * CONCURRENCY gate for the interesting railway's yard: TWO trains call at the yard while
 * the others circulate. The yard services one at a time (single crane), so the second is
 * admitted and queued — never denied while there's room, never blocking the running line
 * (it waits off the line on the yard approach). It asserts:
 *   - both visitors are serviced (released) — neither starves;
 *   - NOTHING is scrambled: every carriage ends either coupled into a train or stabled in
 *     a yard slot (no wagon stranded loose on the running line);
 *   - the bypass trains keep progressing throughout.
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
} from '@trainframe/simulator-ui/demo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const DT = 1 / 60;
const RUN_SECONDS = 420;
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

function coupledToALoco(demo: InterestingRailwayDemo, id: string): boolean {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    const body = demo.world.bodies().find((x) => x.id === cur);
    if (body?.kind === 'loco') return true;
    for (const n of demo.world.coupledTo(cur)) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return false;
}

const wasReleased = (rig: Rig, id: string): boolean =>
  rig.harness.testClient
    .events()
    .some(
      (e) =>
        e.event_type === 'zone_train_released' &&
        (e.payload as { train_id: string }).train_id === id,
    );

const occupancyNow = (rig: Rig): number => {
  const evs = rig.harness.testClient.events().filter((e) => e.event_type === 'zone_state_changed');
  const last = evs[evs.length - 1];
  return last ? (last.payload as { occupancy: number }).occupancy : 0;
};

/** Pump the run; track each train's markers + peak yard occupancy, and the moment the
 *  yard is busy (occupancy ≥ 1) send T2 in too — a second visitor calling at the yard
 *  while the first is being serviced. */
async function pump(rig: Rig): Promise<{ markers: Map<string, Set<string>>; maxOcc: number }> {
  const markers = new Map(rig.demo.trainIds.map((id) => [id, new Set<string>()]));
  let maxOcc = 0;
  let sentT2 = false;
  const batches = Math.ceil(RUN_SECONDS / DT / 12);
  for (let i = 0; i < batches; i++) {
    for (let t = 0; t < 12; t++) {
      rig.demo.step(DT);
      rig.advanceClock(DT * 1000);
    }
    await delay(4);
    for (const e of rig.harness.testClient.events()) {
      if (e.event_type === 'tag_observed') {
        markers.get(e.device_id)?.add((e.payload as { tag_id: string }).tag_id);
      } else if (e.event_type === 'zone_state_changed') {
        maxOcc = Math.max(maxOcc, (e.payload as { occupancy: number }).occupancy);
      }
    }
    if (!sentT2 && occupancyNow(rig) >= 1) {
      rig.harness.server.assignSchedule('T2', 'r2-yard', [M.north, M.east, M.yard, M.south]);
      sentT2 = true;
    }
  }
  return { markers, maxOcc };
}

describe('Interesting-railway yard handles TWO concurrent visitors without scrambling', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig(interestingToLayout(buildMainLoopScene()));
  });

  afterEach(async () => {
    await rig.shutdown();
  });

  it('admits + services both, strands no wagon, keeps the others running', async () => {
    /* T1 calls at the yard; once it's inside being serviced, `pump` sends T2 in too. The
     *  others circulate. Both must come out correctly serviced with nothing scrambled —
     *  whether the two physically overlap in the zone is timing-dependent (logged, not
     *  asserted), but the yard must never deny, strand, or scramble the second caller. */
    rig.harness.server.assignSchedule('T1', 'r1-yard', [M.north, M.east, M.yard, M.south]);
    for (const id of ['T2', 'T3', 'T4']) {
      const r = rig.demo.routes.get(id);
      if (r) rig.harness.server.assignSchedule(id, r.routeId, [...r.stops]);
    }

    const { markers, maxOcc } = await pump(rig);
    console.log(`yard peak occupancy: ${maxOcc}`);

    /* Both visitors were serviced — neither denied nor starved. */
    expect(wasReleased(rig, 'T1'), 'T1 serviced').toBe(true);
    expect(wasReleased(rig, 'T2'), 'T2 serviced').toBe(true);

    /* NO SCRAMBLE: every carriage is either part of a train (coupled to a loco) or
     *  stabled in a yard slot — none stranded loose on the running line. */
    for (const c of rig.demo.world.bodies().filter((b) => b.kind === 'carriage')) {
      const inYard = c.segment.startsWith('yard-');
      const onTrain = coupledToALoco(rig.demo, c.id);
      expect(
        inYard || onTrain,
        `${c.id} is on a train or stabled in the yard (@${c.segment})`,
      ).toBe(true);
    }

    /* The bypass trains kept circulating throughout. */
    for (const id of ['T3', 'T4']) {
      expect(markers.get(id)?.size ?? 0, `${id} kept progressing`).toBeGreaterThanOrEqual(6);
    }
  }, 220_000);
});
