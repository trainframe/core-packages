import { randomUUID } from 'node:crypto';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from '@trainframe/server';
import { BrokerBridge, Simulation, type VirtualCarriage } from '@trainframe/simulator';
import { buildRailyardDemo } from '@trainframe/simulator-ui/demo';
import { compileLayout } from '@trainframe/simulator-ui/track';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * The FOUR-TRAIN railyard SPECTACLE, proven deadlock-free through the real stack
 * (broker + server + scheduler + simulation) on the ACTUAL compiled demo layout
 * (`buildRailyardDemo()`), no browser. This test is the definition of done for
 * the "four trains circulate deadlock-free" claim: if four full-rake trains can
 * jam at the yard throat or foul a junction, this is where it surfaces.
 *
 * What it asserts:
 *   - PROGRESS: all four trains keep traversing markers across a long run — none
 *     stalls indefinitely (the deadlock symptom). We watch each train's
 *     `tag_observed` count keep climbing.
 *   - MIGRATION: at least one coloured carriage moves from one train to another
 *     via the yard (the headline — the same proof as railyard-swap-loop, but
 *     under four concurrent trains on the real layout).
 *   - EXPERIMENTAL DEVICES: the trains pass through the inline TURNTABLE (the
 *     scheduler throws SWITCH-turntable as a train routes trunk → stub) and the
 *     inline LIFT-BRIDGE (a clearance gate on a marker the trains traverse).
 *
 * The layout is enlarged (long runs between every feature) and the four trains'
 * yard visits are staggered, so the section-exclusivity spacing keeps one block
 * between trains and rakes never trail back over a junction — the two fixes that
 * break the old four-train deadlock.
 */

const demo = buildRailyardDemo();
const LAYOUT: Layout = compileLayout(demo.pieces, 'railyard-demo-4train');

/** Marker-graph adjacency over the compiled layout (undirected, for first-hop
 *  selection only — the scheduler itself plans on the directed edges). */
function adjacency(layout: Layout): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const m of layout.markers) adj.set(m.id, new Set());
  for (const e of layout.edges) {
    adj.get(e.from_marker_id)?.add(e.to_marker_id);
    adj.get(e.to_marker_id)?.add(e.from_marker_id);
  }
  return adj;
}

/** Expand one BFS frontier: every not-yet-seen neighbour of the frontier nodes,
 *  marking them seen. */
function expandFrontier(
  adj: ReadonlyMap<string, Set<string>>,
  frontier: ReadonlyArray<string>,
  seen: Set<string>,
): string[] {
  const next: string[] = [];
  for (const m of frontier) {
    for (const n of adj.get(m) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      next.push(n);
    }
  }
  return next;
}

/** Graph distance from `start` to `target` over the undirected marker graph. */
function distance(adj: ReadonlyMap<string, Set<string>>, start: string, target: string): number {
  if (start === target) return 0;
  const seen = new Set<string>([start]);
  let frontier: string[] = [start];
  let d = 0;
  while (frontier.length > 0) {
    d++;
    frontier = expandFrontier(adj, frontier, seen);
    if (seen.has(target)) return d;
  }
  return Number.POSITIVE_INFINITY;
}

const ADJ = adjacency(LAYOUT);

/**
 * The first edge a train homed at `home` should occupy so it starts heading the
 * CIRCULATION way: the neighbour of `home` that is closest (forward) to its
 * second scheduled stop. On the single ring this is unambiguous — the short way
 * to the next stop is the circulation direction. Mirrors the demo's
 * `circulationFacingDeg` intent without reaching into its internals.
 */
function startEdgeFor(
  home: string,
  nextStop: string,
): {
  from_marker_id: string;
  to_marker_id: string;
} {
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const n of ADJ.get(home) ?? []) {
    const d = distance(ADJ, n, nextStop);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  if (best === undefined) throw new Error(`no neighbour of ${home}`);
  return { from_marker_id: home, to_marker_id: best };
}

let harness: Harness;
let simBrokerClient: MqttBrokerClient;
let bridge: BrokerBridge;
let simulation: Simulation;

beforeEach(async () => {
  harness = await startHarness({ layout: LAYOUT });
  await harness.testClient.seedIdentityTags(LAYOUT.markers.map((m) => m.id));

  simulation = new Simulation({ layout: LAYOUT, seed: 1 });
  simulation.seedIdentityTags(LAYOUT);

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

const toVirtual = (c: { id: string; colorId: string }): VirtualCarriage => ({
  id: c.id,
  colorId: c.colorId,
});

const consistOf = (trainId: string): string[] =>
  (simulation.getTrain(trainId)?.getConsist() ?? []).map((c) => c.colorId ?? '');

/** How many markers a train has reported crossing (its progress meter). */
const tagCount = (trainId: string): number =>
  harness.testClient
    .events()
    .filter((e) => e.event_type === 'tag_observed' && e.device_id === trainId).length;

/** True once a train has been released from the yard (serviced + handed back). */
const released = (trainId: string): boolean =>
  harness.testClient
    .events()
    .some(
      (e) =>
        e.event_type === 'zone_train_released' &&
        (e.payload as { train_id: string }).train_id === trainId,
    );

const commandsOfType = (deviceId: string, type: string): number =>
  simulation.getCommandsForDevice(deviceId).filter((c) => c.event_type === type).length;

/**
 * Advance the simulation in small VIRTUAL steps while letting real WALL-CLOCK
 * time accrue between them. The server's scheduler times its station dwell
 * (ADR-028 resume from an ordinary stop) on the wall clock, so a train parked at
 * a scheduled stop only resumes once ~`STATION_DWELL_MS` of WALL time has passed
 * AND it has emitted a `train_status` after that — advancing virtual time too
 * fast (no wall sleeps) would never let a dwell elapse, and the loop would look
 * deadlocked when it is merely waiting out a dwell. The ~8 ms sleep per 50 ms
 * virtual step keeps the demo's several-second dwells firing inside the budget.
 */
const advance = async (): Promise<void> => {
  simulation.advance(50);
  await new Promise((r) => setTimeout(r, 8));
};

const advanceUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 55_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await advance();
  }
  throw new Error(`Timed out: ${message}`);
};

describe('Railyard SPECTACLE: four trains circulate deadlock-free on the demo layout', () => {
  it('keeps all four moving, migrates a carriage via the yard, and uses the turntable + lift-bridge', async () => {
    // The yard zone at the demo's throat, pre-loaded with its two purple spares.
    const yard = simulation.spawnRailyard(demo.yardDeviceId, demo.yardMarker, 6);
    yard.loadSpares(demo.yardSpares.map(toVirtual));
    await harness.testClient.waitForState(`railway/state/devices/${demo.yardDeviceId}`);

    // The switch motors the scheduler throws: the two yard junctions and the
    // inline turntable (a switch with three positions). Each pairs to its marker.
    for (const switchId of demo.switchDeviceIds) {
      const markerId = `M-${switchId.slice('SWITCH-'.length)}`;
      simulation.spawnSwitch(switchId, markerId);
      await harness.testClient.waitForState(`railway/state/devices/${switchId}`);
    }

    // The lift-bridge's clearance gate. Its span is SEATED (down) for the demo,
    // so it grants clearance and the trains cross it — a live gate on the line,
    // not a barrier. (Raising it is the toy-table operator's affordance.)
    simulation.spawnGate(demo.liftBridgeDeviceId);
    await harness.testClient.waitForState(`railway/state/devices/${demo.liftBridgeDeviceId}`);

    // Four trains, each on its home station facing its circulation direction,
    // each with its three-wagon rake. All reversible (zone admission, ADR-027).
    for (const train of demo.trains) {
      const home = train.homeMarker;
      const nextStop = train.stops[1] ?? train.stops[0] ?? home;
      simulation.spawnTrain(train.deviceId, {
        startEdge: startEdgeFor(home, nextStop),
        config: { can_reverse: true, length_mm: 60 },
      });
      simulation.setTrainConsist(train.deviceId, train.consist.map(toVirtual));
      await harness.testClient.waitForState(`railway/state/devices/${train.deviceId}`);
    }

    // Assign every train its cyclic schedule at once — the scheduler suspends at
    // the throat and resumes the loop on release itself (ADR-028). From here on
    // it is all autonomous: no per-lap operator action.
    for (const train of demo.trains) {
      // `train.stops` are already marker ids (`M-stn-amber`, `M-yard`, …) — the
      // form assignSchedule wants.
      harness.server.assignSchedule(train.deviceId, `${train.deviceId}-loop`, train.stops);
    }

    // --- PROGRESS: nobody stalls -------------------------------------------
    // Let the system run, then assert every train has made real progress and
    // KEEPS making it (a second, later sample is strictly higher). A deadlocked
    // train's tag count would plateau.
    await advanceUntil(
      () => demo.trains.every((t) => tagCount(t.deviceId) >= 4),
      'all four trains traverse at least four markers',
    );
    const firstSample = demo.trains.map((t) => tagCount(t.deviceId));

    await advanceUntil(
      () => demo.trains.every((t, i) => tagCount(t.deviceId) > (firstSample[i] ?? 0)),
      'every train keeps moving (no indefinite stall)',
    );
    for (const [i, t] of demo.trains.entries()) {
      expect(
        tagCount(t.deviceId),
        `${t.deviceId} kept moving past ${firstSample[i]}`,
      ).toBeGreaterThan(firstSample[i] ?? 0);
    }

    // --- EXPERIMENTAL DEVICES on the running line --------------------------
    // The inline turntable is thrown by the scheduler as trains route trunk →
    // stub through it (proof a train traversed it as a switched point).
    const turntableSwitchId = demo.switchDeviceIds.find((s) => s.endsWith('turntable'));
    expect(turntableSwitchId).toBeDefined();
    await advanceUntil(
      () =>
        turntableSwitchId !== undefined &&
        commandsOfType(turntableSwitchId, 'set_switch_position') > 0,
      'the scheduler throws the inline turntable for a circulating train',
    );
    // The lift-bridge gate sits on a marker the trains cross: at least one train
    // traverses past it (its marker shows up in the tag stream).
    await advanceUntil(
      () =>
        harness.testClient
          .events()
          .some(
            (e) =>
              e.event_type === 'tag_observed' &&
              (e.payload as { tag_id?: string }).tag_id === demo.liftBridgeMarker,
          ),
      'a train crosses the inline lift-bridge marker',
    );

    // --- MIGRATION: a carriage moves train → train via the yard ------------
    // The first train to be serviced sheds its leading pair into the yard and
    // leaves wearing the purple spares; a later train then leaves wearing that
    // shed pair. We assert at least two trains are serviced and that a NON-purple
    // livery the yard did not start with appears on a train that did not own it —
    // i.e. a wagon migrated.
    await advanceUntil(
      () => demo.trains.filter((t) => released(t.deviceId)).length >= 2,
      'at least two trains are serviced through the yard',
    );

    // The yard started with purple spares only. After two services its spare cut
    // is a coloured pair shed by a visiting train, and at least one train now
    // carries the purple spares (proof the original spares migrated ONTO a train)
    // OR carries a livery that is not its own (a pair migrated train→train).
    const ownColour = new Map(demo.trains.map((t) => [t.deviceId, t.consist[0]?.colorId ?? '']));
    const aTrainWearsForeignLivery = demo.trains.some((t) => {
      const own = ownColour.get(t.deviceId);
      return consistOf(t.deviceId).some((c) => c !== '' && c !== own);
    });
    expect(
      aTrainWearsForeignLivery,
      'a carriage migrated: some train wears a livery it did not start with',
    ).toBe(true);
  }, 150_000);
});
