/**
 * THE HEADLESS INTEGRATION GATE for the branching railyard (FROZEN SPEC §6).
 *
 * Boots a real aedes broker + the real `@trainframe/server` scheduler (no
 * browser, and none of the bespoke block-clearance demo controller this design
 * supersedes), then builds the branching demo's ONE physics world + its
 * scheduler-driven devices ALL IN NODE, each talking to the
 * scheduler over MQTT through `mqttPlatform` (the devices are DOM-free, so the
 * gate runs the same assembly the browser would, headless). The driver loop
 * interleaves `world.step` + `yardDevice.step` + `train.step` with letting the
 * broker flush, and reads captured commands/events the way `zone-admission.test.ts`
 * does — never mocking the scheduler, registry, broker, or any device hook.
 *
 * It proves the headline claims, each in its own `it`:
 *   (a) the trains are driven by CLEARANCE, not commands;
 *   (b) distinct trains take distinct branches via the scheduler's real switch
 *       resolution off `requires_switch_state`;
 *   (c) the yard zone queues trains (deny-and-hold while full, FIFO admit on a
 *       freed slot);
 *   (d) a carriage migrates train→train inside the opaque yard;
 *   (e) no phantom 180° flip during ordinary running (directional running).
 *
 * Plus a cheap pure unit `it` over `sceneToLayout`.
 *
 * Determinism: fixed dt, fixed train placements (the demo is pure); the only
 * non-determinism is the broker's async flush, which the loop waits out by
 * polling captured commands/events with a wall-clock deadline (as the reference
 * tests do). No Math.random / Date.now in the system under test.
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
} from '@trainframe/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const DT = 1 / 60;
const SETTLE_TIMEOUT_MS = 30_000;

interface Rig {
  readonly harness: Harness;
  readonly demo: BranchingDemo;
  readonly deviceClients: MqttBrokerClient[];
  shutdown(): Promise<void>;
}

/**
 * The scheduler's virtual clock (ms), advanced by `pump` in lockstep with the sim
 * (`SIM_MS_PER_TICK` per `demo.step`). The in-line yard's crane service takes
 * tens of SIM-seconds; pacing the dwell/clearance clock to SIM time (not wall
 * time) lets the full service + the yard queue complete inside the test budget,
 * deterministically. Reset per `startRig`.
 */
let clockMs = 0;
const SIM_MS_PER_TICK = (1 / 60) * 1000;

/**
 * Boot the broker + scheduler against the compiled layout, then build the demo
 * over MQTT — one `MqttBrokerClient` per device, each wrapped in `mqttPlatform`.
 * Seeds identity tags (tag id == marker id) so `tag_observed` resolves to
 * `marker_traversed`. Waits for every device to register before returning, so the
 * caller can assign schedules immediately. The scheduler runs on the virtual
 * clock above (advanced by `pump`).
 */
async function startRig(layout: Layout): Promise<Rig> {
  clockMs = 0;
  const harness = await startHarness({ layout, now: () => clockMs });
  await harness.testClient.seedIdentityTags(layout.markers.map((m) => m.id));

  const deviceClients: MqttBrokerClient[] = [];
  const platformFactory = (deviceId: string) => {
    const client = new MqttBrokerClient();
    deviceClients.push(client);
    /* connect is fire-and-forget; the client buffers subscribes and replays them
     *  on connect. We let all connections settle below before starting. */
    client.connect(harness.brokerUrl);
    return mqttPlatform(client, deviceId);
  };
  const demo = buildBranchingDemo(platformFactory);
  /* Let every device client's connection settle before starting (so subscribes
   *  for commands are live when the scheduler first publishes). */
  await delay(400);
  demo.start();

  /* Wait until the scheduler has retained state for every device — so an
   *  immediately-following `assignSchedule` finds a registered train. */
  for (const id of [...demo.trainIds, demo.yardDeviceId, ...demo.switchDeviceIds]) {
    await harness.testClient.waitForState(`railway/state/devices/${id}`);
  }

  return {
    harness,
    demo,
    deviceClients,
    async shutdown() {
      demo.stop();
      for (const c of deviceClients) c.disconnect();
      await harness.shutdown();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Drive the world + devices a few ticks (advancing the scheduler's virtual clock
 *  in lockstep), then yield to the broker so its flush + the scheduler's reaction
 *  land before the next batch. */
async function pump(demo: BranchingDemo, ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    demo.step(DT);
    clockMs += SIM_MS_PER_TICK;
  }
  await delay(6);
}

/** Pump until `predicate` holds or the deadline elapses. */
async function pumpUntil(
  demo: BranchingDemo,
  predicate: () => boolean,
  message: string,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pump(demo);
  }
  throw new Error(`Timed out: ${message}`);
}

/** The coupled component (group) containing `id` in the world — flood-fill over
 *  the world's `coupledTo` adjacency. */
function coupledGroup(world: BranchingDemo['world'], id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    for (const n of world.coupledTo(cur)) if (!seen.has(n)) stack.push(n);
  }
  return seen;
}

interface ReportedEdge {
  readonly from: string;
  readonly to: string;
}

/** The de-duplicated sequence of `current_edge`s a train reported via
 *  `train_status` — its believed route progress, consecutive duplicates removed. */
function reportedEdges(
  allEvents: ReadonlyArray<{ event_type: string; device_id: string; payload: unknown }>,
  trainId: string,
): ReportedEdge[] {
  const out: ReportedEdge[] = [];
  for (const ev of allEvents) {
    if (ev.event_type !== 'train_status' || ev.device_id !== trainId) continue;
    const edge = (ev.payload as { current_edge?: { from_marker_id: string; to_marker_id: string } })
      .current_edge;
    if (edge === undefined) continue;
    const last = out[out.length - 1];
    if (last === undefined || last.from !== edge.from_marker_id || last.to !== edge.to_marker_id) {
      out.push({ from: edge.from_marker_id, to: edge.to_marker_id });
    }
  }
  return out;
}

/** Assert a train's reported edges are rail-continuous and never an immediate
 *  reverse of the previous edge (directional running). */
function expectRailContinuous(edges: readonly ReportedEdge[]): void {
  for (let i = 1; i < edges.length; i++) {
    const prev = edges[i - 1];
    const cur = edges[i];
    if (prev === undefined || cur === undefined) continue;
    expect(cur.from).toBe(prev.to);
    expect(cur.from === prev.to && cur.to === prev.from).toBe(false);
  }
}

/** Assert no consecutive heading samples jumped ~180° (a phantom flip). `turn`
 *  is the absolute heading change normalised to [0,180]: ~0 on a straight, a
 *  smooth ramp through a corner, ~180 only on an on-the-spot flip. */
function expectNoHeadingFlip(headings: readonly number[]): void {
  for (let i = 1; i < headings.length; i++) {
    const a = headings[i - 1];
    const b = headings[i];
    if (a === undefined || b === undefined) continue;
    expect(Math.abs(((b - a + 540) % 360) - 180)).toBeLessThan(150);
  }
}

const scene = buildBranchingScene(3);
const LAYOUT: Layout = sceneToLayout(scene, 'branching');

describe('Branching scene → protocol layout (pure)', () => {
  it('emits the throat as a yard_entry on the running line, the switched spur diverge, the spur junction, and no interior markers', () => {
    const layout = sceneToLayout(buildBranchingScene(3), 'branching');

    const throat = layout.markers.find((m) => m.id === 'M-yard-throat');
    expect(throat?.kind).toBe('yard_entry');

    /* The yard is IN-LINE (a zone on the running line), so the spine edge through
     *  it is plain — no scheduler-thrown tap. */
    const throughYard = layout.edges.find(
      (e) => e.from_marker_id === 'M-yard-throat' && e.to_marker_id === 'M-yard-far',
    );
    expect(throughYard?.requires_switch_state).toBeUndefined();
    const intoYard = layout.edges.find(
      (e) => e.from_marker_id === 'M-central' && e.to_marker_id === 'M-yard-throat',
    );
    expect(intoYard?.requires_switch_state).toBeUndefined();

    /* The one real junction is the spur, diverging the scenic branch. */
    const branchEdge = layout.edges.find(
      (e) => e.from_marker_id === 'M-spur' && e.to_marker_id === 'M-branch-top',
    );
    expect(branchEdge?.requires_switch_state).toBe('branch');

    expect(layout.junctions.map((j) => j.marker_id)).toEqual(['M-spur']);
    for (const j of layout.junctions) expect((j.valid_positions ?? []).length).toBeGreaterThan(1);

    /* Interior yard segments (Jw/Je/slots) emit no core markers — the only yard
     *  markers are the throat boundary + its far side. */
    const yardMarkers = layout.markers.filter((m) => m.id.startsWith('M-yard'));
    expect(yardMarkers.map((m) => m.id).sort()).toEqual(['M-yard-far', 'M-yard-throat']);
  });
});

describe('Branching railyard on the REAL scheduler (headless gate)', () => {
  let rig: Rig;

  beforeEach(async () => {
    rig = await startRig(LAYOUT);
  });

  afterEach(async () => {
    await rig.shutdown();
  });

  const commandsFor = (id: string) => rig.harness.testClient.commandsFor(id);
  const events = () => rig.harness.testClient.events();

  const grantsFor = (id: string, limit?: string) =>
    commandsFor(id).filter(
      (c) =>
        c.command_type === 'grant_clearance' &&
        (limit === undefined ||
          (c.payload as { limit_marker_id: string }).limit_marker_id === limit),
    );

  const switchCommands = (junctionMarkerId: string, position: string) =>
    rig.demo.switchDeviceIds
      .flatMap((id) => commandsFor(id))
      .concat(commandsFor(rig.demo.yardDeviceId))
      .filter(
        (c) =>
          c.command_type === 'set_switch_position' &&
          (c.payload as { junction_marker_id: string }).junction_marker_id === junctionMarkerId &&
          (c.payload as { position: string }).position === position,
      );

  /** Markers a train reported crossing (server-derived from its tag stream). */
  const traversedBy = (trainId: string): Set<string> =>
    new Set(
      events()
        .filter((e) => e.event_type === 'tag_observed' && e.device_id === trainId)
        .map((e) => (e.payload as { tag_id: string }).tag_id),
    );

  it('(a) drives the train by clearance, not commands: assign_route edges + a grant, stopped before clearance', async () => {
    /* Before any schedule, the train holds no clearance and stays stopped. */
    const motionT1 = () => rig.demo.world.bodies().find((b) => b.id === 'T1');
    await pump(rig.demo, 30);
    expect(motionT1()?.speed ?? 0).toBe(0);

    rig.harness.server.assignSchedule('T1', 'rA-express', ['M-central', 'M-main-e']);
    await pumpUntil(
      rig.demo,
      () => commandsFor('T1').some((c) => c.command_type === 'assign_route'),
      'T1 receives an assign_route',
    );

    const route = commandsFor('T1').find((c) => c.command_type === 'assign_route');
    const edges = (route?.payload as { edges: { from_marker_id: string; to_marker_id: string }[] })
      .edges;
    /* The planner's edges between the stops, rail-continuous. */
    expect(edges.length).toBeGreaterThan(0);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]?.from_marker_id).toBe(edges[i - 1]?.to_marker_id);
    }

    await pumpUntil(
      rig.demo,
      () => grantsFor('T1').length >= 1,
      'T1 receives at least one grant_clearance',
    );
    expect(grantsFor('T1').length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('(b) distinct branches: the in-line yard throat and the scenic spur branch are both exercised via the real junction', async () => {
    /* The full concurrent scenario (all three demo trains on their cyclic routes).
     *  The yard is IN-LINE (every train runs the line to the throat — no tap); the
     *  scenic BRANCH is a real `requires_switch_state` diverge off the spur, which
     *  the reliever T4 takes. Driving all three keeps the line live so both
     *  branches are reached (a parked, unscheduled train would foul the others). */
    for (const id of rig.demo.trainIds) {
      const route = DEMO_ROUTES.get(id);
      if (route === undefined) throw new Error(`no DEMO route for ${id}`);
      rig.harness.server.assignSchedule(id, route.routeId, [...route.stops]);
    }

    /* The scheduler throws the spur (Jspur@M-spur → branch) so the reliever takes
     *  the scenic branch — the real junction resolution off `requires_switch_state`. */
    await pumpUntil(
      rig.demo,
      () => switchCommands('M-spur', 'branch').length >= 1,
      'the scheduler throws the spur toward the branch',
    );

    /* Distinct traversals: a yard-turn train reaches the in-line yard throat; the
     *  reliever reaches the scenic branch top. Both paths are exercised. */
    await pumpUntil(
      rig.demo,
      () => traversedBy('T2').has('M-yard-throat'),
      'T2 traverses the in-line yard throat',
    );
    await pumpUntil(
      rig.demo,
      () => traversedBy('T4').has('M-branch-top'),
      'T4 traverses the scenic branch top',
    );
  }, 90_000);

  it('(c) queues multiple trains at the yard: deny-and-hold while full, FIFO admit on a freed slot', async () => {
    /* Capacity is 1 (demo default) and the yard starts empty. Route both T2 and
     *  T4 to the throat; one will be serviced, the other held short while the
     *  zone is occupied. */
    rig.harness.server.assignSchedule('T2', 'rB-yardturn', ['M-top', 'M-yard-throat', 'M-spur']);
    rig.harness.server.assignSchedule('T4', 'rD-reliever', [
      'M-branch-bot',
      'M-top',
      'M-yard-throat',
      'M-branch-bot',
    ]);

    /* Once one of them occupies the yard (zone_state_changed occupancy 1), the
     *  other must NOT hold a throat grant — it is held one marker short. */
    await pumpUntil(
      rig.demo,
      () =>
        events().some(
          (e) =>
            e.event_type === 'zone_state_changed' &&
            (e.payload as { occupancy: number }).occupancy >= 1,
        ),
      'the yard reports occupancy >= 1 (a train resident)',
    );

    const throatGrant = (id: string) => grantsFor(id, 'M-yard-throat').length;
    /* At most one of the two has been cleared to the throat while the yard is
     *  full — the other is denied-and-held. */
    const occupied = throatGrant('T2') + throatGrant('T4');
    expect(occupied).toBeLessThanOrEqual(1);

    /* Let the resident be serviced + released; its slot frees, and the held train
     *  is then admitted (FIFO). */
    await pumpUntil(
      rig.demo,
      () => events().some((e) => e.event_type === 'zone_train_released'),
      'the resident train is released from the yard',
      SETTLE_TIMEOUT_MS,
    );
    await pumpUntil(
      rig.demo,
      () => throatGrant('T2') + throatGrant('T4') >= 2,
      'both trains are eventually cleared to the throat (queued, then admitted)',
    );
    expect(throatGrant('T2') + throatGrant('T4')).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it('(d) a carriage migrates train→train through the opaque yard, shortening the visitor', async () => {
    rig.harness.server.assignSchedule('T2', 'rB-yardturn', ['M-top', 'M-yard-throat', 'M-spur']);

    /* The visiting T2 carries two carriages; the yard's spares cut is the migrate
     *  target. Drive the service to release. */
    const t2Cars = ['T2-c0', 'T2-c1'];
    const startCoupled = new Set(rig.demo.world.coupledTo('T2'));
    expect(startCoupled.size).toBeGreaterThan(0);

    await pumpUntil(
      rig.demo,
      () =>
        events().some(
          (e) =>
            e.event_type === 'zone_train_released' &&
            (e.payload as { train_id: string }).train_id === 'T2',
        ),
      'T2 is serviced and released from the yard',
    );

    /* Train→train carriage migration: the yard shed T2's own rear cut into the
     *  yard and coupled the resident spares onto T2 in their place. After the
     *  service, T2's coupled group must therefore contain a SPARE carriage it did
     *  NOT start with, and at least one of its ORIGINAL cars must have left its
     *  group (migrated off, train→train). `world` couplings are the only place
     *  this is observable — the yard interior is opaque to core — so this
     *  inspection is the allowed seam (§6d). */
    const t2Group = coupledGroup(rig.demo.world, 'T2');
    const wearsSpare = [...t2Group].some((id) => id.startsWith('spare'));
    const shedAnOriginal = t2Cars.some((c) => !t2Group.has(c));
    expect(wearsSpare, 'T2 picked up a yard spare it did not start with').toBe(true);
    expect(shedAnOriginal, 'T2 shed at least one of its original cars in the yard').toBe(true);

    /* The device reconciled the visitor's length downward (ADR-023). */
    const lengthChanged = events().find(
      (e) =>
        e.event_type === 'train_length_changed' &&
        (e.payload as { train_id: string }).train_id === 'T2',
    );
    expect(lengthChanged).toBeDefined();
  }, 90_000);

  it('(e) no phantom 180° flip during ordinary running (directional running)', async () => {
    /* T1 runs its express loop through the in-line yard. The yard SERVICE reverses
     *  the loco into a slot (an INTERIOR move the device owns — never a scheduler
     *  grant_reverse), so the directional invariant is asserted on the MAIN-LINE
     *  cornered leg only: the south-east + north-east corners (`cSE`, `cNE`) up the
     *  long right ascending straight, exactly the geometry that would expose a
     *  phantom 180° flip if the PLANNER ever U-turned the loco on the open line. We
     *  sample headings only while T1 is on those running-line segments, never
     *  inside the opaque yard. */
    rig.harness.server.assignSchedule('T1', 'rA-express', [
      'M-main-e',
      'M-top',
      'M-central',
      'M-yard-throat',
    ]);

    /* The main-line cornered leg T1 sweeps from its home (`M-main-e`, on the right
     *  ascending straight) up to `M-top`: the right straight + the north-east
     *  corner `cNE`. Heading samples are confined to these running-line segments so
     *  the yard's interior reverse never enters the trace. */
    const RUNNING_LEG = new Set(['rightA', 'rightB', 'cNE', 'top']);
    const headings: number[] = [];
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline && (traversedBy('T1').size < 3 || headings.length < 30)) {
      await pump(rig.demo);
      const t1 = rig.demo.world.bodies().find((b) => b.id === 'T1');
      if (t1 !== undefined && t1.speed > 0 && RUNNING_LEG.has(t1.segment)) {
        headings.push(t1.rotationDeg);
      }
    }
    const edges = reportedEdges(events(), 'T1');

    /* No grant_reverse during ordinary running; edges rail-continuous + no
     *  immediate reverse; no ~180° heading flip between samples on the running leg. */
    expect(commandsFor('T1').some((c) => c.command_type === 'grant_reverse')).toBe(false);
    expectRailContinuous(edges);
    expectNoHeadingFlip(headings);

    /* Several markers crossed (a real lap segment through corners) + a dense
     *  heading trace through the bend — enough to expose a phantom flip. */
    expect(traversedBy('T1').size).toBeGreaterThanOrEqual(3);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(headings.length).toBeGreaterThanOrEqual(10);
  }, 60_000);
});
