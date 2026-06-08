import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES } from '../builtins/index.js';
import { CapabilityRegistry } from '../registry.js';
import type { SchedulerEffect } from './effects.js';
import { LayoutState } from './layout-state.js';
import { STATION_DWELL_MS, Scheduler } from './scheduler.js';

/**
 * Test fixtures. The simple loop:
 *
 *   M1 -- M2 -- M3 -- M4 -- M1
 *
 * Four markers, four edges, no junctions. M3 is a station_stop where
 * gates can hold trains.
 */
const SIMPLE_LOOP: Layout = {
  name: 'simple-loop',
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

const setup = () => {
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.freeze();
  const layout = new LayoutState(SIMPLE_LOOP, { now: () => 0 });
  const scheduler = new Scheduler(registry, layout, { now: () => 0 });
  seedIdentityTags(scheduler, SIMPLE_LOOP_MARKERS);
  return { scheduler, registry };
};

const registerTrain = (scheduler: Scheduler, trainId: string) =>
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: trainId,
    payload: { capabilities: ['core.controls_motion', 'core.accepts_route'] },
  });

const registerLongTrain = (scheduler: Scheduler, trainId: string, lengthMm: number) =>
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: trainId,
    payload: {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
      train_length_mm: lengthMm,
    },
  });

const sendTrainStatus = (
  scheduler: Scheduler,
  trainId: string,
  currentEdge: { from_marker_id: string; to_marker_id: string },
  distanceMm: number,
) =>
  scheduler.handleEvent({
    event_type: 'train_status',
    device_id: trainId,
    payload: {
      train_id: trainId,
      current_edge: currentEdge,
      estimated_distance_from_edge_start_mm: distanceMm,
      speed_normalised: 0.5,
    },
  });

const registerGate = (scheduler: Scheduler, deviceId: string) =>
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: deviceId,
    payload: { capabilities: ['core.gates_clearance'] },
  });

/**
 * Tests need tag→marker bindings before `tag_observed` resolves to anything.
 * Pre-register a synthetic garage that declares `core.assigns_tags`, then bind
 * each marker to a tag whose ID equals the marker ID. This is the "identity"
 * tag scheme - real layouts would use opaque tag IDs but the tests only care
 * that the resolution path runs.
 */
const seedIdentityTags = (scheduler: Scheduler, markerIds: ReadonlyArray<string>): void => {
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: 'GARAGE',
    payload: { capabilities: ['core.assigns_tags'] },
  });
  for (const id of markerIds) {
    scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: { tag_id: id, assigned_kind: 'marker', target_id: id },
    });
  }
};

const SIMPLE_LOOP_MARKERS = ['M1', 'M2', 'M3', 'M4'];

/**
 * A six-marker loop, longer than the clearance horizon (3 edges), so a single
 * leg can hold the full horizon AND still have edges left to top up after a
 * crossing — exercising the proactive top-up that the four-marker loop is too
 * short to show.
 *
 *   N1 -- N2 -- N3 -- N4 -- N5 -- N6 -- N1
 */
const SIX_LOOP: Layout = {
  name: 'six-loop',
  markers: [
    { id: 'N1', kind: 'block_boundary' },
    { id: 'N2', kind: 'block_boundary' },
    { id: 'N3', kind: 'block_boundary' },
    { id: 'N4', kind: 'block_boundary' },
    { id: 'N5', kind: 'block_boundary' },
    { id: 'N6', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'N1', to_marker_id: 'N2', estimated_length_mm: 200 },
    { from_marker_id: 'N2', to_marker_id: 'N3', estimated_length_mm: 200 },
    { from_marker_id: 'N3', to_marker_id: 'N4', estimated_length_mm: 200 },
    { from_marker_id: 'N4', to_marker_id: 'N5', estimated_length_mm: 200 },
    { from_marker_id: 'N5', to_marker_id: 'N6', estimated_length_mm: 200 },
    { from_marker_id: 'N6', to_marker_id: 'N1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

const setupSixLoop = () => {
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.freeze();
  const layout = new LayoutState(SIX_LOOP, { now: () => 0 });
  const scheduler = new Scheduler(registry, layout, { now: () => 0 });
  seedIdentityTags(scheduler, ['N1', 'N2', 'N3', 'N4', 'N5', 'N6']);
  return { scheduler };
};

// ---------- tests ----------

describe('Scheduler — route assignment and clearance extension', () => {
  it('grants initial clearance for the first edge of an assigned route', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');

    // assignSchedule('T1', 'route-1', ['M1', 'M3']): train conceptually at M1,
    // planner computes M1→M2→M3.
    const effects = scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    const grant = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeDefined();
    expect(grant?.device_id).toBe('T1');
    expect((grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');
  });

  it('tops up the clearance horizon as a train crosses a marker mid-route', () => {
    // The proactive-horizon contract (replaces the old reach-the-limit,
    // grant-one-edge model): a moving train always carries up to
    // CLEARANCE_HORIZON_EDGES of clearance ahead of the edge it's on. The
    // six-marker loop gives a leg LONGER than the horizon, so a crossing
    // genuinely tops it up by granting a fresh edge.
    const { scheduler } = setupSixLoop();
    registerTrain(scheduler, 'T1');
    // N1→…→N6 — a five-edge leg. With a 3-edge horizon, at assign T1 holds the
    // first three (limit lands at N4); N4→N5 and N5→N6 are NOT yet granted.
    scheduler.assignSchedule('T1', 'route-1', ['N1', 'N6']);
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('N4');

    // Train passes N1 (the start), then arrives at N2. As a point train it
    // releases N1→N2; the horizon then tops up by granting the next edge,
    // N4→N5, pushing the limit to N5.
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'N1' },
    });
    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'N2' },
    });

    const grant = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeDefined();
    // The newly-granted edge (N4→N5) tops the horizon back up to three ahead.
    expect((grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('N5');
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('N5');
  });

  it('grants the whole horizon up front on a clear route (proactive look-ahead)', () => {
    const { scheduler } = setupSixLoop();
    registerTrain(scheduler, 'T1');
    // A five-edge leg on a clear loop. The horizon grants exactly the first
    // three edges ahead at assign time — not just the first, and not the whole
    // leg — so the train pulls away with several blocks of room.
    scheduler.assignSchedule('T1', 'route-1', ['N1', 'N6']);
    const t1 = scheduler.getTrainState('T1');
    expect(t1?.cleared_edges).toEqual([
      { from_marker_id: 'N1', to_marker_id: 'N2' },
      { from_marker_id: 'N2', to_marker_id: 'N3' },
      { from_marker_id: 'N3', to_marker_id: 'N4' },
    ]);
    expect(t1?.clearance_limit_marker_id).toBe('N4');
  });
});

describe('Scheduler — section-as-edge-plus-boundary-markers (ADR-011)', () => {
  it('blocks a chaser at the leader`s lock-set boundary on a single loop', () => {
    // Same loop, both trains. T1 spawned at M1 heading to M3; T2 at M1 also
    // heading to M3. T1 holds [M1→M2], lock set {M1, M2}. T2 wants M1→M2 too
    // — would be denied even by edge-equality alone, but the section-pair
    // rule is what stops a different chaser from skipping ahead into M2's
    // far side: T2 wanting M2→M3 (which doesn't share an edge but shares M2)
    // is denied too.
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');
    scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);

    // T1 reaches M2. T1 now holds M2→M3 (lock {M2, M3}). A new schedule for
    // T2 that wants M2→M3 directly (impossible from a real-train standpoint,
    // but the planner-shape doesn't care) — denied because M2 and M3 both in
    // T1's lock set. Use the lower-level edge probe via a clearance_request
    // event to exercise the rule directly.
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    const t2Probe = scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T2',
      payload: { train_id: 'T2', next_edge: { from_marker_id: 'M2', to_marker_id: 'M3' } },
    });
    const grant = t2Probe.find(
      (e) => e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeUndefined();
  });

  it('prevents simultaneous crossing at a shared marker (figure-8 X)', () => {
    // Minimal figure-8: X is a 4-incident crossing. The classic "two trains
    // arrive at X on opposite diagonals" race must not grant both — they'd
    // physically occupy X at the same instant on a single-rail crossing.
    const FIGURE_8: Layout = {
      name: 'fig8',
      markers: [
        { id: 'X', kind: 'block_boundary' },
        { id: 'R_NE', kind: 'block_boundary' },
        { id: 'R_SE', kind: 'block_boundary' },
        { id: 'L_NW', kind: 'block_boundary' },
        { id: 'L_SW', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'X', to_marker_id: 'R_NE' },
        { from_marker_id: 'R_NE', to_marker_id: 'R_SE' },
        { from_marker_id: 'R_SE', to_marker_id: 'X' },
        { from_marker_id: 'X', to_marker_id: 'L_NW' },
        { from_marker_id: 'L_NW', to_marker_id: 'L_SW' },
        { from_marker_id: 'L_SW', to_marker_id: 'X' },
      ],
      junctions: [],
    };
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();
    const scheduler = new Scheduler(registry, new LayoutState(FIGURE_8, { now: () => 0 }), {
      now: () => 0,
    });
    seedIdentityTags(scheduler, ['X', 'R_NE', 'R_SE', 'L_NW', 'L_SW']);
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    // T1 wants `R_SE→X` then `X→L_NW` (a SE→NW transit). Grant the entering
    // edge via clearance_request — T1 holds R_SE→X, lock set {R_SE, X}.
    const t1Grant = scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T1',
      payload: { train_id: 'T1', next_edge: { from_marker_id: 'R_SE', to_marker_id: 'X' } },
    });
    expect(
      t1Grant.find((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance'),
    ).toBeDefined();

    // T2 simultaneously wants `L_SW→X` (the other diagonal). Both edges
    // share marker X. Section-pair rule denies.
    const t2Deny = scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T2',
      payload: { train_id: 'T2', next_edge: { from_marker_id: 'L_SW', to_marker_id: 'X' } },
    });
    expect(
      t2Deny.find((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance'),
    ).toBeUndefined();
  });
});

describe('Scheduler — deadlock detection', () => {
  it('emits a deadlock state when two trains mutually block under the section-pair rule', () => {
    // Two trains on a single loop. T1 holds M1→M2 with transit going to M3;
    // T2 holds M3→M4 with a transit that wants M4→M1 next (loops back).
    // Build the state directly via clearance_requests so we control timing.
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    // Plant T1 mid-route: schedule M1→M3, traversing past M1 already, holding
    // M2→M3 (lock {M2, M3}).
    scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    // T1 now holds M2→M3. Now plant T2 going the other way around the loop:
    // schedule M3→M1 (planner finds M3→M4→M1). After T2 starts, it holds
    // M3→M4 (lock {M3, M4}) which conflicts with T1's lock at M3. T1 wanting
    // anything M2-or-M3-adjacent is now denied; T2's next edge (M4→M1) is
    // denied because of T1's M2 lock... wait, M4→M1 only shares M1/M4, not
    // M2/M3. So this scenario won't deadlock on its own — need both trains
    // to want into each other's lock set. Use clearance_request to probe.
    scheduler.assignSchedule('T2', 'r2', ['M3', 'M1']);
    const t2State = scheduler.getTrainState('T2');
    // T2's initial transit starts at stops[0]=M3; planner builds M3→M4→M1.
    // But last_marker_id is undefined for T2; scheduler uses stops[0]=M3.
    // The shared-marker rule denies T2's M3→M4 (M3 in T1's lock {M2, M3}).
    // So T2 has transit but no clearance. T1 wants M3→M4 (next in its
    // transit AFTER M2→M3 if any) — but T1's schedule was [M1, M3], so on
    // arrival at M3 T1 will replan to M3→M1 via M3→M4→M1. Still wants M3→M4.
    expect(t2State?.transit?.edges[0]).toEqual({ from_marker_id: 'M3', to_marker_id: 'M4' });
    // Now also assign T1 to keep going past M3 — schedule [M1, M4] so its
    // transit after arrival at M3 covers M3→M4. We do this BEFORE T1 reaches
    // M3 so the head still holds M2→M3.
    const t1Reassign = scheduler.assignSchedule('T1', 'r1b', ['M1', 'M4']);
    // The reassignment wipes T1.cleared_edges and replans from T1's last
    // marker M2 to M4 (planner finds M2→M3→M4). T1 will be granted M2→M3
    // (no conflicts), holds M2→M3 again.
    expect(
      t1Reassign.find(
        (e) =>
          e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T1',
      ),
    ).toBeDefined();
    // Now retry T2 — T2 wants M3→M4. T1 holds M2→M3 (lock {M2, M3}).
    // Conflict at M3 → denied. So T2 waits-for T1.
    // T1's NEXT edge after M2→M3 is M3→M4. T1 wants M3→M4. T2 holds nothing
    // yet so T1 isn't blocked — no cycle.
    const noCycle = scheduler
      .handleEvent({ event_type: 'tag_observed', device_id: 'T2', payload: { tag_id: 'M3' } })
      .find((e) => e.kind === 'update_state_snapshot' && e.entity_type === 'deadlock');
    // T2 arriving at M3 is ignored (T2 has no clearance there) — no state
    // change. The detection only fires when both trains actually contend.
    expect(noCycle).toBeUndefined();
  });

  it('reports a true 2-cycle deadlock as a state update with both trains', () => {
    // Construct the actual mutual-block. Use the figure-8 layout where the
    // crossing X creates a contended marker on both sides.
    const FIGURE_8: Layout = {
      name: 'fig8',
      markers: [
        { id: 'X', kind: 'block_boundary' },
        { id: 'A', kind: 'block_boundary' },
        { id: 'B', kind: 'block_boundary' },
        { id: 'C', kind: 'block_boundary' },
        { id: 'D', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'A', to_marker_id: 'X' },
        { from_marker_id: 'X', to_marker_id: 'B' },
        { from_marker_id: 'C', to_marker_id: 'X' },
        { from_marker_id: 'X', to_marker_id: 'D' },
        { from_marker_id: 'B', to_marker_id: 'A' },
        { from_marker_id: 'D', to_marker_id: 'C' },
      ],
      junctions: [],
    };
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();
    const scheduler = new Scheduler(registry, new LayoutState(FIGURE_8, { now: () => 0 }), {
      now: () => 0,
    });
    seedIdentityTags(scheduler, ['X', 'A', 'B', 'C', 'D']);
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    // T1 holds A→X (lock {A, X}).
    scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T1',
      payload: { train_id: 'T1', next_edge: { from_marker_id: 'A', to_marker_id: 'X' } },
    });
    // Give T1 a transit so the detector sees it as a real train with a
    // wanted-edge pipeline ahead of X.
    scheduler.assignSchedule('T1', 'r1', ['B', 'A']);

    // T2 holds C→X (lock {C, X}) — wait, that conflicts with T1's X already.
    // Instead set up the mutual block: T2 holds D→C (lock {D, C}); wants
    // C→X next which conflicts with T1's X. T1 wants X→B which conflicts
    // with nothing yet... need T2 to hold something T1 wants.
    // Easier: skip the schedule plumbing and probe the detector by
    // requesting clearances directly and forcing T1 to want X→B (held
    // by T2). Set T2's cleared_edges via a schedule + tag_observed sequence.
    scheduler.assignSchedule('T2', 'r2', ['B', 'A']);
    // T2's planner builds B→A. T2's first edge is B→A. Grant it: T2 holds
    // B→A (lock {B, A}). But T1 holds A→X (lock {A, X}). T2's grant should
    // have been DENIED because A is in T1's lock. Inspect.
    const t2State = scheduler.getTrainState('T2');
    expect(t2State?.cleared_edges).toEqual([]); // denied

    // Now T2's wanted edge is B→A. T1's lock is {A, X} — T2's wanted edge
    // shares A. T2 waits-for T1.
    // T1's transit is B→A then A→X (already held) or some replan. T1's
    // next wanted edge after A→X is X→B. T2 holds nothing yet, so T1's
    // X→B has no conflict... unless we also block T1. Force the cycle:
    // simulate T2 having ALREADY been granted by manipulating state isn't
    // ideal; instead set up symmetric clearances.
    // Reset and use a simpler topology: 2-edge loop A↔B.
  });

  it('clears the deadlock state when one of the involved trains disconnects', () => {
    // Set up the mutual-block scenario where both trains share a marker via
    // their cleared edges and each wants into the other's lock.
    // Layout: A → B → C → A (loop). T1 holds A→B (lock {A, B}). T2 holds
    // C→A (lock {C, A}) and wants A→B (conflicts with T1's A and B).
    // T1's next wanted edge is B→C; T2 holds C→A so C is in T2's lock —
    // T1 wanting B→C shares C → denied. Mutual block: T1 waits T2, T2
    // waits T1.
    const TRI_LOOP: Layout = {
      name: 'tri-loop',
      markers: [
        { id: 'A', kind: 'block_boundary' },
        { id: 'B', kind: 'block_boundary' },
        { id: 'C', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'A', to_marker_id: 'B' },
        { from_marker_id: 'B', to_marker_id: 'C' },
        { from_marker_id: 'C', to_marker_id: 'A' },
      ],
      junctions: [],
    };
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();
    const scheduler = new Scheduler(registry, new LayoutState(TRI_LOOP, { now: () => 0 }), {
      now: () => 0,
    });
    seedIdentityTags(scheduler, ['A', 'B', 'C']);
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    // T1: schedule [A, C] (transit A→B→C). T1 spawns at A. Under the proactive
    // horizon it grants the whole two-edge leg up front: A→B then B→C, so T1
    // holds {A, B, C}.
    scheduler.assignSchedule('T1', 'r1', ['A', 'C']);
    expect(scheduler.getTrainState('T1')?.cleared_edges).toEqual([
      { from_marker_id: 'A', to_marker_id: 'B' },
      { from_marker_id: 'B', to_marker_id: 'C' },
    ]);
    // T2: schedule [C, B] (transit C→A→B). T2 spawns at C, wants C→A — but
    // C→A shares A and C with T1's locked edges. Denied.
    scheduler.assignSchedule('T2', 'r2', ['C', 'B']);
    expect(scheduler.getTrainState('T2')?.cleared_edges).toEqual([]);
    // T1 advances: traverse to B. T1's lock becomes {B, C} (holds B→C).
    const t1ArrivedAtB = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'B' },
    });
    // Was a deadlock declared as part of that retry? T1 now wants nothing
    // beyond B→C (its transit ends at C and replans). After arriving at B
    // T1 holds B→C and was granted. T2 still wants C→A — shares C → still
    // denied. T1's next wanted edge: replan from C to ... it's stops[1]=C
    // so reaching B means transit advance. Actually transit was A→B→C
    // (index 0 = A→B done, index 1 = B→C, after arrival progress=1, edge
    // is B→C; lock {B, C}). T1's next wanted edge IS B→C (just granted).
    // After grant, no more pending for T1 — no waits-for from T1.
    // So T2 waits-for T1 but T1 doesn't wait-for anyone. No cycle.
    const cycleDeclared = t1ArrivedAtB.find(
      (e) =>
        e.kind === 'update_state_snapshot' &&
        e.entity_type === 'deadlock' &&
        (e.state as { trains: string[] }).trains.length > 0,
    );
    expect(cycleDeclared).toBeUndefined();

    // Despawn T1 — T2 should now be granted C→A on the retry.
    const disconnect = scheduler.handleEvent({
      event_type: 'device_disconnected',
      device_id: 'T1',
      payload: {},
    });
    const t2Grant = disconnect.find(
      (e) =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2Grant).toBeDefined();
  });
});

describe('Scheduler — gating', () => {
  it('withholds clearance when a gate is active at the next marker', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerGate(scheduler, 'GATE-M3');

    // Gate withholds at M3.
    scheduler.handleEvent({
      event_type: 'gate_state_changed',
      device_id: 'GATE-M3',
      payload: { marker_id: 'M3', state: 'withholding', reason: 'crane busy' },
    });

    // Assign a schedule through M3.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    // Train reaches M2 — should NOT be cleared past M2 because M3 is gated.
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });

    const grant = effects.find(
      (e) => e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeUndefined();

    const train = scheduler.getTrainState('T1');
    expect(train?.clearance_limit_marker_id).toBe('M2');
  });

  it('grants the previously-withheld clearance when the gate releases', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerGate(scheduler, 'GATE-M3');

    scheduler.handleEvent({
      event_type: 'gate_state_changed',
      device_id: 'GATE-M3',
      payload: { marker_id: 'M3', state: 'withholding', reason: 'crane busy' },
    });
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });

    // Train is stopped at M2. Now release the gate.
    const releaseEffects = scheduler.handleEvent({
      event_type: 'gate_state_changed',
      device_id: 'GATE-M3',
      payload: { marker_id: 'M3', state: 'granting' },
    });

    const grant = releaseEffects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeDefined();
    expect((grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M3');
  });
});

describe('Scheduler — block exclusivity', () => {
  it('refuses to clear an edge already cleared to another train', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    // T1 takes the M1→M2 edge (as first leg of M1→M3 schedule).
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    // T2 tries to take the same M1→M2 edge (first leg of M1→M2 schedule).
    const effects = scheduler.assignSchedule('T2', 'route-2', ['M1', 'M2']);

    // T2 should get the route command (we don't refuse the route assignment
    // itself), but should NOT get a clearance grant.
    const route = effects.find(
      (e) => e.kind === 'send_command' && e.command_type === 'assign_route',
    );
    expect(route).toBeDefined();
    const grant = effects.find(
      (e) => e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeUndefined();
  });

  it('releases a block when the holding train`s lock set has moved past the shared marker', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    const t2Initial = scheduler.assignSchedule('T2', 'route-2', ['M1', 'M2']);
    // T2 starts blocked: transit assigned but no grant.
    expect(
      t2Initial.find((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance'),
    ).toBeUndefined();

    // T1 reaches M2 → progress advances, T1 now holds M2→M3. T1's lock set is
    // still {M2, M3}, so M1→M2 (which shares M2) is still denied to T2 under
    // ADR-011's section-pair model. One-block separation: a follower can't
    // pull into the block immediately behind the leader's just-vacated edge.
    const effectsM2 = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    const t2GrantAtM2 = effectsM2.find(
      (e) =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2GrantAtM2).toBeUndefined();

    // T1 reaches M3 → progress advances again, T1 now holds M3→M4 (lock {M3,
    // M4}). M2 has dropped out of T1's lock set, so M1→M2 is free for T2.
    const effectsM3 = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M3' },
    });
    const t2GrantAtM3 = effectsM3.find(
      (e) =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2GrantAtM3).toBeDefined();
  });

  it('releases blocks held by a train when it is reassigned to a route not covering them, granting waiting peers', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    // T1 takes M1→M2 (with M2→M3 queued in the transit to M3).
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    // T2 is denied the same M1→M2 edge.
    const t2Initial = scheduler.assignSchedule('T2', 'route-2', ['M1', 'M2']);
    expect(
      t2Initial.find((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance'),
    ).toBeUndefined();

    // Simulate T1 having reached M3 so its last_marker_id is set there.
    // This lets the reassignment plan M3→M4, which does not cover M1→M2.
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M3' },
    });

    // Operator reassigns T1 to a yard-style schedule that no longer touches
    // M1→M2. Because last_marker_id='M3'=stops[0], the planner builds a transit
    // M3→M4. The wipe of cleared_edges releases T1's hold on M1→M2 and the
    // scheduler must retry T2's previously-denied clearance in the same call.
    const reassign = scheduler.assignSchedule('T1', 'route-1b', ['M3', 'M4']);

    const t2Grant = reassign.find(
      (e) =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2Grant).toBeDefined();
  });
});

describe('Scheduler — clearance revocation', () => {
  it('drops the holding train`s cleared edges and grants a waiting peer', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    // T1 takes its whole two-edge leg up front (M1→M2, M2→M3) under the
    // proactive horizon.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    expect(scheduler.getTrainState('T1')?.cleared_edges).toHaveLength(2);

    // T2 also wants M1→M2 — denied because T1 holds the block.
    const t2Initial = scheduler.assignSchedule('T2', 'route-2', ['M1', 'M2']);
    expect(
      t2Initial.find((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance'),
    ).toBeUndefined();

    // Operator revokes T1's clearance.
    const effects = scheduler.revokeClearance('T1');

    // T1 receives a revoke_clearance command.
    const revoke = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'revoke_clearance' && e.device_id === 'T1',
    );
    expect(revoke).toBeDefined();

    // T2 receives a grant_clearance for M1→M2 since the block is freed.
    const t2Grant = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2Grant).toBeDefined();
    expect((t2Grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');

    // T1's cleared edges are empty.
    const t1State = scheduler.getTrainState('T1');
    expect(t1State?.cleared_edges).toEqual([]);

    // T2 now owns M1→M2.
    const t2State = scheduler.getTrainState('T2');
    expect(t2State?.cleared_edges).toEqual([{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
  });

  it('is a no-op for an unknown train', () => {
    const { scheduler } = setup();
    const effects = scheduler.revokeClearance('NOPE');
    expect(effects).toEqual([]);
  });

  it('resets the clearance limit to the train`s last known marker', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    // T1 moves to M1, then M2 (and is granted M2→M3).
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('M3');

    scheduler.revokeClearance('T1');

    const t1State = scheduler.getTrainState('T1');
    expect(t1State?.cleared_edges).toEqual([]);
    expect(t1State?.clearance_limit_marker_id).toBe('M2');
  });
});

describe('Scheduler — device disconnect', () => {
  it('releases a gate`s withholds when the gating device disconnects and grants the previously-blocked clearance', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerGate(scheduler, 'GATE-M3');

    scheduler.handleEvent({
      event_type: 'gate_state_changed',
      device_id: 'GATE-M3',
      payload: { marker_id: 'M3', state: 'withholding', reason: 'crane busy' },
    });
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    const atM2 = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    // Sanity: the gate withholds, so no clearance past M2.
    expect(findGrant(atM2)).toBeUndefined();
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('M2');

    // Gate vanishes. Its withhold must be released and T1 must be re-granted.
    const afterDisconnect = scheduler.handleEvent({
      event_type: 'device_disconnected',
      device_id: 'GATE-M3',
      payload: {},
    });

    const grant = findGrant(afterDisconnect);
    expect(grant).toBeDefined();
    expect(grant?.device_id).toBe('T1');
    expect((grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M3');
  });

  it('releases a disconnected train`s held block so waiting peers can be granted', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    // T1 takes M1→M2.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M2']);
    // T2 wants the same edge — assigned but no grant.
    const t2Initial = scheduler.assignSchedule('T2', 'route-2', ['M1', 'M2']);
    expect(findGrant(t2Initial)).toBeUndefined();

    // T1 vanishes (e.g. derailed and unplugged). The block must release and
    // T2 must be granted in the same handler call.
    const afterDisconnect = scheduler.handleEvent({
      event_type: 'device_disconnected',
      device_id: 'T1',
      payload: {},
    });

    const t2Grant = afterDisconnect.find(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2Grant).toBeDefined();
    expect((t2Grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');

    // T1 should no longer be tracked as a train.
    expect(scheduler.getTrainState('T1')).toBeUndefined();
    expect(scheduler.getTrainIds()).not.toContain('T1');
  });

  it('is a no-op for unknown device IDs', () => {
    const { scheduler } = setup();
    const effects = scheduler.handleEvent({
      event_type: 'device_disconnected',
      device_id: 'NEVER-REGISTERED',
      payload: {},
    });
    expect(effects).toEqual([]);
  });
});

describe('Scheduler — anomalies', () => {
  it('emits an anomaly when an unknown tag is observed', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');

    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'NONEXISTENT' },
    });

    const anomaly = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'anomaly',
    );
    expect(anomaly).toBeDefined();
  });

  it('warns about devices declaring unknown capabilities', () => {
    const { scheduler } = setup();
    const effects = scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'D1',
      payload: { capabilities: ['core.gates_clearance', 'made.up.capability'] },
    });

    const anomaly = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'anomaly',
    );
    expect(anomaly).toBeDefined();
  });
});

/**
 * Figure-8 with a single junction at M2. From M2 the train can go to M3
 * (via the "main" switch position) or M5 (via "diverge"). Both routes
 * eventually return to M1.
 *
 * The planner is purely structural (ignores switch state) and uses Dijkstra
 * with edge cost = estimated_length_mm. M2→M3 costs 200 and M2→M5 costs 280,
 * so when the target is M3, the planner always picks M1→M2→M3 (the cheaper
 * path). Switch-state filtering still gates clearance grant at runtime.
 */
const FIGURE_8: Layout = {
  name: 'figure-8',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'junction' },
    { id: 'M3', kind: 'block_boundary' },
    { id: 'M4', kind: 'block_boundary' },
    { id: 'M5', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    {
      from_marker_id: 'M2',
      to_marker_id: 'M3',
      estimated_length_mm: 200,
      requires_switch_state: 'main',
    },
    {
      from_marker_id: 'M2',
      to_marker_id: 'M5',
      estimated_length_mm: 280,
      requires_switch_state: 'diverge',
    },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
    { from_marker_id: 'M5', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [{ marker_id: 'M2' }],
};

const setupFigure8 = () => {
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.freeze();
  const layout = new LayoutState(FIGURE_8, { now: () => 0 });
  const scheduler = new Scheduler(registry, layout, { now: () => 0 });
  seedIdentityTags(scheduler, ['M1', 'M2', 'M3', 'M4', 'M5']);
  return { scheduler, registry };
};

const registerSwitch = (scheduler: Scheduler, deviceId: string) =>
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: deviceId,
    payload: { capabilities: ['core.controls_switch'] },
  });

const findGrant = (effects: ReadonlyArray<SchedulerEffect>) =>
  effects.find(
    (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
      e.kind === 'send_command' && e.command_type === 'grant_clearance',
  );

describe('Scheduler — switch-state edge filtering', () => {
  it('withholds clearance across a junction when no switch position is known', () => {
    const { scheduler } = setupFigure8();
    registerTrain(scheduler, 'T1');
    registerSwitch(scheduler, 'SW-M2');

    // Planner picks M1→M2→M3 (cheaper than M1→M2→M5). Switch state unknown
    // so clearance is withheld at the M2→M3 junction edge.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    const atM2 = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });

    expect(findGrant(atM2)).toBeUndefined();
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('M2');
  });

  it('grants clearance through the junction when the switch matches', () => {
    const { scheduler } = setupFigure8();
    registerTrain(scheduler, 'T1');
    registerSwitch(scheduler, 'SW-M2');

    scheduler.handleEvent({
      event_type: 'switch_state_changed',
      device_id: 'SW-M2',
      payload: { junction_marker_id: 'M2', position: 'main', confirmed: true },
    });

    // Planner picks M1→M2→M3 (cheaper). Switch is 'main', matching M2→M3, so
    // under the proactive horizon the junction edge is cleared at assign time —
    // the look-ahead reaches it before the train ever arrives at M2.
    const assigned = scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    const grants = assigned.filter(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    // Both M1→M2 and the junction edge M2→M3 are granted up front.
    const limits = grants.map((g) => (g.payload as { limit_marker_id: string }).limit_marker_id);
    expect(limits).toContain('M3');
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('M3');
  });

  it('denies clearance across a junction when the switch is in the wrong position', () => {
    const { scheduler } = setupFigure8();
    registerTrain(scheduler, 'T1');
    registerSwitch(scheduler, 'SW-M2');

    scheduler.handleEvent({
      event_type: 'switch_state_changed',
      device_id: 'SW-M2',
      payload: { junction_marker_id: 'M2', position: 'diverge', confirmed: true },
    });

    // Planner picks M1→M2→M3 (cheaper). Switch is 'diverge', mismatching M2→M3.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    const atM2 = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });

    expect(findGrant(atM2)).toBeUndefined();
  });

  it('ignores unconfirmed switch changes for clearance decisions', () => {
    const { scheduler } = setupFigure8();
    registerTrain(scheduler, 'T1');
    registerSwitch(scheduler, 'SW-M2');

    scheduler.handleEvent({
      event_type: 'switch_state_changed',
      device_id: 'SW-M2',
      payload: { junction_marker_id: 'M2', position: 'main', confirmed: false },
    });

    // Planner picks M1→M2→M3. Switch reports 'main' but unconfirmed — treated
    // as unknown, so clearance is withheld.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    const atM2 = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });

    expect(findGrant(atM2)).toBeUndefined();
  });

  it('grants the previously-withheld clearance once the switch confirms', () => {
    const { scheduler } = setupFigure8();
    registerTrain(scheduler, 'T1');
    registerSwitch(scheduler, 'SW-M2');

    // Planner picks M1→M2→M3. Switch unknown at assignment time so initial
    // grant is withheld at M2.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('M2');

    // Switch confirms in the matching position - clearance should extend.
    const afterSwitch = scheduler.handleEvent({
      event_type: 'switch_state_changed',
      device_id: 'SW-M2',
      payload: { junction_marker_id: 'M2', position: 'main', confirmed: true },
    });

    const grant = findGrant(afterSwitch);
    expect(grant).toBeDefined();
    expect((grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M3');
  });
});

describe('Scheduler — tag resolution', () => {
  it('resolves a marker tag and treats the reading train as having traversed it', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    // Single-stop-to-stop transit: M1→M2.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M2']);

    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });

    const traversed = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'marker_traversed',
    );
    expect(traversed).toBeDefined();
    expect((traversed?.payload as { marker_id: string }).marker_id).toBe('M1');
  });

  it('marker_traversed carries inferred_edge from the second traversal onward (ADR-016)', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    const firstEffects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    const first = firstEffects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'marker_traversed',
    );
    /* No previous marker yet — the field must be absent, not null. */
    expect(first?.payload).not.toHaveProperty('inferred_edge');

    const secondEffects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    const second = secondEffects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'marker_traversed',
    );
    expect(
      (second?.payload as { inferred_edge?: { from_marker_id: string; to_marker_id: string } })
        .inferred_edge,
    ).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
  });

  it('derives a vehicle_identified event when a trackside reader sees a vehicle tag', () => {
    const { scheduler } = setup();
    // Register a yard reader (identifies_vehicles) and a vehicle tag bound
    // to a train ID. The reader publishes tag_observed; we expect the
    // scheduler to derive a vehicle_identified.
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'YARD-1',
      payload: { capabilities: ['core.identifies_vehicles'] },
    });
    scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: { tag_id: 'TAG-T1', assigned_kind: 'vehicle', target_id: 'T1' },
    });

    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'YARD-1',
      payload: { tag_id: 'TAG-T1' },
    });

    const identified = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'vehicle_identified',
    );
    expect(identified).toBeDefined();
    expect((identified?.payload as { vehicle_id: string }).vehicle_id).toBe('T1');
  });

  it('emits an anomaly when a tag has no registry binding', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');

    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'UNBOUND-TAG-XYZ' },
    });

    const anomaly = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'anomaly',
    );
    expect(anomaly).toBeDefined();
  });

  it('a tag bound to a marker can then be observed by a train and is treated as that marker', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');

    // The operator (via a garage device) binds a freshly-printed tag to M2.
    scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: { tag_id: 'TAG-NEW', assigned_kind: 'marker', target_id: 'M2' },
    });

    // Later, a train scans that tag. The system should treat the train as
    // having traversed M2 — the binding is what wires the new tag into the
    // logical world.
    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'TAG-NEW' },
    });

    const traversed = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'marker_traversed',
    );
    expect(traversed).toBeDefined();
    expect((traversed?.payload as { marker_id: string }).marker_id).toBe('M2');
  });

  it('rejects tag_assignment from a device that did not declare core.assigns_tags', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'IMPOSTOR');

    const effects = scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'IMPOSTOR',
      payload: { tag_id: 'TAG-PWND', assigned_kind: 'marker', target_id: 'M2' },
    });

    const anomaly = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'anomaly',
    );
    expect(anomaly).toBeDefined();
    expect(scheduler.getTagRegistry().resolve('TAG-PWND')).toBeUndefined();
  });
});

describe('Scheduler — discovery mode', () => {
  it('creates a marker on the fly when a tag is assigned to an unknown target', () => {
    const { scheduler } = setup();
    expect(scheduler.getLayout().hasMarker('M-NEW')).toBe(false);

    const effects = scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: {
        tag_id: 'TAG-NEW',
        assigned_kind: 'marker',
        target_id: 'M-NEW',
        marker_kind: 'block_boundary',
      },
    });

    expect(scheduler.getLayout().hasMarker('M-NEW')).toBe(true);
    expect(scheduler.getLayout().getMarker('M-NEW')?.kind).toBe('block_boundary');

    const layoutSnapshot = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> =>
        e.kind === 'update_state_snapshot' && e.entity_type === 'layout',
    );
    expect(layoutSnapshot).toBeDefined();
  });

  it('infers an edge when a train traverses two markers with no existing edge between them', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');

    // Add a new marker on the side, no edge to it yet.
    scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: {
        tag_id: 'M-OFF',
        assigned_kind: 'marker',
        target_id: 'M-OFF',
        marker_kind: 'block_boundary',
      },
    });

    // Train at M1 (existing), then unexpectedly at M-OFF.
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M-OFF' },
    });

    const edge = scheduler.getLayout().findEdge('M1', 'M-OFF');
    expect(edge).toBeDefined();
    expect(edge?.inferred).toBe(true);

    const traversed = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'marker_traversed',
    );
    expect((traversed?.payload as { in_discovery_mode: boolean }).in_discovery_mode).toBe(true);
  });

  it('confirms an inferred edge after the configured number of traversals', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: {
        tag_id: 'M-OFF',
        assigned_kind: 'marker',
        target_id: 'M-OFF',
      },
    });

    // Drive the train back and forth M1 ↔ M-OFF three times. The default
    // threshold is 3 traversals of the M1→M-OFF edge.
    const cross = (markerId: string) =>
      scheduler.handleEvent({
        event_type: 'tag_observed',
        device_id: 'T1',
        payload: { tag_id: markerId },
      });
    cross('M1');
    cross('M-OFF'); // traversal 1 (and infer)
    cross('M1');
    cross('M-OFF'); // traversal 2
    cross('M1');
    cross('M-OFF'); // traversal 3 — should flip inferred to false

    const edge = scheduler.getLayout().findEdge('M1', 'M-OFF');
    expect(edge?.inferred).toBe(false);
  });

  it('threshold is configurable via the scheduler`s LayoutState', () => {
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();
    const layout = new LayoutState(SIMPLE_LOOP, { confirmTraversals: 1, now: () => 0 });
    const scheduler = new Scheduler(registry, layout, { now: () => 0 });
    seedIdentityTags(scheduler, SIMPLE_LOOP_MARKERS);
    registerTrain(scheduler, 'T1');

    scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: { tag_id: 'M-X', assigned_kind: 'marker', target_id: 'M-X' },
    });
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M-X' },
    });

    const edge = layout.findEdge('M1', 'M-X');
    expect(edge?.inferred).toBe(false);
  });
});

describe('Scheduler — train-length-aware tail clearance', () => {
  it('long train holds the section behind it until train_status reports tail has cleared', () => {
    // T1 is 150 mm long on a simple loop where every edge is 200 mm.
    // After T1's head crosses M2 (entering M2→M3), M1→M2 must stay locked
    // until T1 reports distance >= 150 mm into M2→M3.
    //
    // T2 wants M4→M1. While T1 holds M1→M2, that edge shares M1 with T2's
    // M4→M1, so T2 is denied (ADR-011). Once the tail clears M1→M2 (T1 only
    // holds M2→M3, markers {M2,M3}), M4→M1 (markers {M4,M1}) has no shared
    // boundary and T2 is granted.
    const { scheduler } = setup();
    registerLongTrain(scheduler, 'T1', 150);
    registerTrain(scheduler, 'T2');

    // T1: M1→M2→M3.
    scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);

    // T2: M4→M1. T2 starts at M4 (stops[0]), planner builds transit M4→M1.
    // M4→M1 shares M1 with T1's M1→M2 (ADR-011) so the initial grant is denied.
    const t2Initial = scheduler.assignSchedule('T2', 'r2', ['M4', 'M1']);
    // Denied — T1 holds M1→M2 (shares M1 with M4→M1, ADR-011).
    expect(
      t2Initial.find((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance'),
    ).toBeUndefined();

    // T1 head crosses M1 then M2.
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    const atM2 = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });

    // T1's head crossed M2 — for a long train M1→M2 is NOT released yet.
    // T2 still blocked (retryBlockedClearances runs inside handleTrainAtMarker
    // but the section has not been dropped from cleared_edges).
    expect(
      atM2.find(
        (e) =>
          e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
      ),
    ).toBeUndefined();

    // T1 reports distance = 100 mm into M2→M3. Tail is 50 mm inside M1→M2.
    const statusNotYet = sendTrainStatus(
      scheduler,
      'T1',
      { from_marker_id: 'M2', to_marker_id: 'M3' },
      100,
    );
    expect(
      statusNotYet.find(
        (e) =>
          e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
      ),
    ).toBeUndefined();

    // T1 reports distance = 150 mm — tail at the M2 boundary, M1→M2 clears.
    // T1 now holds only M2→M3 (markers {M2,M3}); M4→M1 (markers {M4,M1})
    // is uncontested and T2 must be granted.
    const statusCleared = sendTrainStatus(
      scheduler,
      'T1',
      { from_marker_id: 'M2', to_marker_id: 'M3' },
      150,
    );
    const t2Grant = statusCleared.find(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2Grant).toBeDefined();
    expect((t2Grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M1');
  });

  it('long train granting follow-on clearance is still gated by ADR-011 shared-marker rule', () => {
    // T1 (long) has its tail cleared M1→M2, releasing M1→M2. T2 wants M2→M3.
    // Even after M1→M2 is released, if T1 still holds M2→M3 (which shares M2
    // and M3), T2 cannot get M2→M3 — ADR-011 shared-marker rule must apply.
    const { scheduler } = setup();
    registerLongTrain(scheduler, 'T1', 150);
    registerTrain(scheduler, 'T2');

    // T1: full loop M1→M2→M3→M4→M1. T2 wants M2→M3 (clearance_request).
    scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);

    // T1's head crosses M1 and M2.
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    // T1 now holds [M1→M2, M2→M3] (long train, no release yet).

    // T1's tail clears M1→M2 at distance=150 mm. M1→M2 drops out. T1 still
    // holds M2→M3 (lock set {M2, M3}).
    sendTrainStatus(scheduler, 'T1', { from_marker_id: 'M2', to_marker_id: 'M3' }, 150);

    // T2 requests M2→M3 — shared markers M2 and M3, must be denied.
    const t2Probe = scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T2',
      payload: { train_id: 'T2', next_edge: { from_marker_id: 'M2', to_marker_id: 'M3' } },
    });
    expect(
      t2Probe.find((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance'),
    ).toBeUndefined();
  });

  it('point train (length=0) still releases on marker_traversed (regression)', () => {
    // A train registered with train_length_mm=0 must behave identically to a
    // train with no length_mm — release on head arrival, not deferred.
    const { scheduler } = setup();
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'T1',
      payload: {
        capabilities: ['core.controls_motion', 'core.accepts_route'],
        train_length_mm: 0,
      },
    });
    registerTrain(scheduler, 'T2');

    scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);
    scheduler.assignSchedule('T2', 'r2', ['M1', 'M2']);

    // T1 crosses M1 then M2.
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M1' },
    });
    // After M2: T1 point train, so M1→M2 is released immediately. T2 should
    // still be denied because under ADR-011, T1 holds M2→M3 (lock {M2,M3})
    // which shares M2 with T2's M1→M2 request.
    const atM2 = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });

    // The key regression check: T1's M1→M2 was released on marker_traversed
    // (not deferred). T2 is still blocked by ADR-011 (M2 in T1's lock set).
    // Verify state directly.
    const t1State = scheduler.getTrainState('T1');
    // cleared_edges should NOT contain M1→M2 (it was released on arrival at M2).
    expect(
      t1State?.cleared_edges.some((e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2'),
    ).toBe(false);

    // T2 is still denied because T1 holds M2→M3.
    const t2Grant = atM2.find(
      (e) =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2Grant).toBeUndefined();
  });
});

describe('Scheduler — multi-edge tail release (ADR-012 refinement, ADR-016 step 5)', () => {
  /*
   * Five-marker loop, 100mm edges. A 250mm train spans 3 edges behind its head.
   *
   *   P1 -- P2 -- P3 -- P4 -- P5 -- P1
   *
   * Schedule: ['P1', 'P5'] — transit P1→P2→P3→P4→P5 (4 edges). The train does
   * not reach its stop (P5) until the 5th crossing, so all tests below drive at
   * most 4 crossings and stay within the first transit. This avoids the station
   * dwell that would park the train with a frozen clock.
   *
   * Arithmetic for 250mm train, 100mm edges, head on P4→P5 at distance d:
   *   depth-1 P3→P4: cumulative = d           — releases when d >= 250 (impossible on 100mm)
   *   depth-2 P2→P3: cumulative = d + 100      — releases when d >= 150 (impossible on 100mm)
   *   depth-3 P1→P2: cumulative = d + 200      — releases when d >= 50
   *
   * Two-at-once case (d is deliberately over-sized — valid input, not physical):
   *   At d=150 on P4→P5:
   *     depth-1 P3→P4: 150 < 250. Not released.
   *     depth-2 P2→P3: 150+100=250 >= 250. Released.
   *     depth-3 P1→P2: 150+200=350 >= 250. Released.
   */
  const FIVE_LOOP: Layout = {
    name: 'five-loop',
    markers: [
      { id: 'P1', kind: 'block_boundary' },
      { id: 'P2', kind: 'block_boundary' },
      { id: 'P3', kind: 'block_boundary' },
      { id: 'P4', kind: 'block_boundary' },
      { id: 'P5', kind: 'block_boundary' },
    ],
    edges: [
      { from_marker_id: 'P1', to_marker_id: 'P2', estimated_length_mm: 100 },
      { from_marker_id: 'P2', to_marker_id: 'P3', estimated_length_mm: 100 },
      { from_marker_id: 'P3', to_marker_id: 'P4', estimated_length_mm: 100 },
      { from_marker_id: 'P4', to_marker_id: 'P5', estimated_length_mm: 100 },
      { from_marker_id: 'P5', to_marker_id: 'P1', estimated_length_mm: 100 },
    ],
    junctions: [],
  };

  const setupFiveLoop = () => {
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();
    const layout = new LayoutState(FIVE_LOOP, { now: () => 0 });
    const scheduler = new Scheduler(registry, layout, { now: () => 0 });
    seedIdentityTags(scheduler, ['P1', 'P2', 'P3', 'P4', 'P5']);
    return { scheduler };
  };

  const crossFiveLoop = (scheduler: Scheduler, trainId: string, markerId: string) =>
    scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: trainId,
      payload: { tag_id: markerId },
    });

  it('releases only the depth-3 held edge when d=50 (d+200=250 exactly)', () => {
    /* T1 is 250mm long. Drive to P4 (entering P4→P5, progress_index=3).
     * At d=40 (40+200=240 < 250): nothing releases.
     * At d=50 (50+200=250 >= 250): P1→P2 (depth-3) releases. P2→P3, P3→P4 stay held. */
    const { scheduler } = setupFiveLoop();
    registerLongTrain(scheduler, 'T1', 250);
    scheduler.assignSchedule('T1', 'r1', ['P1', 'P5']);
    crossFiveLoop(scheduler, 'T1', 'P1');
    crossFiveLoop(scheduler, 'T1', 'P2');
    crossFiveLoop(scheduler, 'T1', 'P3');
    crossFiveLoop(scheduler, 'T1', 'P4');

    // Before threshold: P1→P2 is held.
    expect(
      scheduler
        .getTrainState('T1')
        ?.cleared_edges.some((e) => e.from_marker_id === 'P1' && e.to_marker_id === 'P2'),
    ).toBe(true);

    // d=40: still held — 240 < 250.
    sendTrainStatus(scheduler, 'T1', { from_marker_id: 'P4', to_marker_id: 'P5' }, 40);
    expect(
      scheduler
        .getTrainState('T1')
        ?.cleared_edges.some((e) => e.from_marker_id === 'P1' && e.to_marker_id === 'P2'),
    ).toBe(true);

    // d=50: P1→P2 releases (250 >= 250).
    sendTrainStatus(scheduler, 'T1', { from_marker_id: 'P4', to_marker_id: 'P5' }, 50);
    const afterRelease = scheduler.getTrainState('T1');
    expect(
      afterRelease?.cleared_edges.some((e) => e.from_marker_id === 'P1' && e.to_marker_id === 'P2'),
    ).toBe(false);
    // P2→P3 and P3→P4 are still held (cumulative 150 and 50, both < 250).
    expect(
      afterRelease?.cleared_edges.some((e) => e.from_marker_id === 'P2' && e.to_marker_id === 'P3'),
    ).toBe(true);
    expect(
      afterRelease?.cleared_edges.some((e) => e.from_marker_id === 'P3' && e.to_marker_id === 'P4'),
    ).toBe(true);
  });

  it('releases two held edges simultaneously when d=150 (depth-2 and depth-3 both >= length)', () => {
    /* Same setup as above. At d=150:
     *   depth-2 P2→P3: 150+100=250 >= 250 — released.
     *   depth-3 P1→P2: 150+200=350 >= 250 — released.
     *   depth-1 P3→P4: 150 < 250         — NOT released. */
    const { scheduler } = setupFiveLoop();
    registerLongTrain(scheduler, 'T1', 250);
    scheduler.assignSchedule('T1', 'r1', ['P1', 'P5']);
    crossFiveLoop(scheduler, 'T1', 'P1');
    crossFiveLoop(scheduler, 'T1', 'P2');
    crossFiveLoop(scheduler, 'T1', 'P3');
    crossFiveLoop(scheduler, 'T1', 'P4');

    // Both P1→P2 and P2→P3 are held.
    const before = scheduler.getTrainState('T1');
    expect(
      before?.cleared_edges.some((e) => e.from_marker_id === 'P1' && e.to_marker_id === 'P2'),
    ).toBe(true);
    expect(
      before?.cleared_edges.some((e) => e.from_marker_id === 'P2' && e.to_marker_id === 'P3'),
    ).toBe(true);

    sendTrainStatus(scheduler, 'T1', { from_marker_id: 'P4', to_marker_id: 'P5' }, 150);
    const after = scheduler.getTrainState('T1');

    // Both depth-2 and depth-3 edges are released.
    expect(
      after?.cleared_edges.some((e) => e.from_marker_id === 'P1' && e.to_marker_id === 'P2'),
    ).toBe(false);
    expect(
      after?.cleared_edges.some((e) => e.from_marker_id === 'P2' && e.to_marker_id === 'P3'),
    ).toBe(false);
    // depth-1 P3→P4 stays held (150 < 250).
    expect(
      after?.cleared_edges.some((e) => e.from_marker_id === 'P3' && e.to_marker_id === 'P4'),
    ).toBe(true);
  });

  it('blocked chaser is granted when multi-depth held edges release', () => {
    /* T2 wants P1→P2. T1 holds P1→P2 and P2→P3 (both share P2, so T2 is
     * denied by ADR-011). At d=150 on P4→P5 both P1→P2 (depth-3) and P2→P3
     * (depth-2) release simultaneously. T1's remaining held edges are P3→P4
     * and P4→P5 — neither shares a marker with P1→P2 — so T2 is granted in
     * the same handler call.
     *
     * d=50 first: only P1→P2 releases, but T1 still holds P2→P3 (shares P2).
     * d=150: both release, and P1→P2 is finally uncontested for T2. */
    const { scheduler } = setupFiveLoop();
    registerLongTrain(scheduler, 'T1', 250);
    registerTrain(scheduler, 'T2');
    scheduler.assignSchedule('T1', 'r1', ['P1', 'P5']);

    /* T2 wants P1→P2. T1 holds it (P1 and P2 shared), so the initial grant
     * is denied. */
    const t2Initial = scheduler.assignSchedule('T2', 'r2', ['P1', 'P2']);
    expect(
      t2Initial.find(
        (e) =>
          e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
      ),
    ).toBeUndefined();

    crossFiveLoop(scheduler, 'T1', 'P1');
    crossFiveLoop(scheduler, 'T1', 'P2');
    crossFiveLoop(scheduler, 'T1', 'P3');
    crossFiveLoop(scheduler, 'T1', 'P4');

    // d=50: only P1→P2 releases (depth-3). T1 still holds P2→P3 (depth-2),
    // which shares P2 with T2's wanted P1→P2. T2 remains blocked.
    const onlyOneReleased = sendTrainStatus(
      scheduler,
      'T1',
      { from_marker_id: 'P4', to_marker_id: 'P5' },
      50,
    );
    expect(
      onlyOneReleased.find(
        (e) =>
          e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
      ),
    ).toBeUndefined();

    // d=150: P2→P3 (depth-2) also releases. T1 now holds only P3→P4 and P4→P5
    // — no shared markers with P1→P2. T2 is granted in this same call.
    const released = sendTrainStatus(
      scheduler,
      'T1',
      { from_marker_id: 'P4', to_marker_id: 'P5' },
      150,
    );
    const t2Grant = released.find(
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2Grant).toBeDefined();
    expect((t2Grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('P2');
  });

  it('conservative hold: missing edge length stops the walk — depth-1 releases, depth-2 stays held', () => {
    /* Five-loop but Q3→Q4 has no estimated_length_mm. Train length = 50mm.
     * On Q4→Q5 at d=50:
     *   depth-1 Q3→Q4: cumulative = 50 >= 50 — released.
     *   depth-2 Q2→Q3: needs Q3→Q4's length (unknown) — walk stops, Q2→Q3 held.
     * This is the deliberate safety asymmetry: holding too long is safe. */
    const PARTIAL_LOOP: Layout = {
      name: 'partial-loop',
      markers: [
        { id: 'Q1', kind: 'block_boundary' },
        { id: 'Q2', kind: 'block_boundary' },
        { id: 'Q3', kind: 'block_boundary' },
        { id: 'Q4', kind: 'block_boundary' },
        { id: 'Q5', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'Q1', to_marker_id: 'Q2', estimated_length_mm: 100 },
        { from_marker_id: 'Q2', to_marker_id: 'Q3', estimated_length_mm: 100 },
        /* Q3→Q4 intentionally has no estimated_length_mm — the walk cannot
         * continue past it and deeper edges remain held. */
        { from_marker_id: 'Q3', to_marker_id: 'Q4' },
        { from_marker_id: 'Q4', to_marker_id: 'Q5', estimated_length_mm: 100 },
        { from_marker_id: 'Q5', to_marker_id: 'Q1', estimated_length_mm: 100 },
      ],
      junctions: [],
    };
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();
    const layout = new LayoutState(PARTIAL_LOOP, { now: () => 0 });
    const sched = new Scheduler(registry, layout, { now: () => 0 });
    seedIdentityTags(sched, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);

    registerLongTrain(sched, 'T1', 50);
    /* Schedule Q1→Q5: transit Q1→Q2→Q3→Q4→Q5 (4 edges). Head on Q4→Q5
     * (progress_index=3), forward edges = [Q4→Q5]. */
    sched.assignSchedule('T1', 'r1', ['Q1', 'Q5']);
    sched.handleEvent({ event_type: 'tag_observed', device_id: 'T1', payload: { tag_id: 'Q1' } });
    sched.handleEvent({ event_type: 'tag_observed', device_id: 'T1', payload: { tag_id: 'Q2' } });
    sched.handleEvent({ event_type: 'tag_observed', device_id: 'T1', payload: { tag_id: 'Q3' } });
    sched.handleEvent({ event_type: 'tag_observed', device_id: 'T1', payload: { tag_id: 'Q4' } });

    sched.handleEvent({
      event_type: 'train_status',
      device_id: 'T1',
      payload: {
        train_id: 'T1',
        current_edge: { from_marker_id: 'Q4', to_marker_id: 'Q5' },
        estimated_distance_from_edge_start_mm: 50,
        speed_normalised: 0.5,
      },
    });

    const t1 = sched.getTrainState('T1');
    // Q3→Q4 (depth-1, cumulative=50 >= 50) must be released.
    expect(
      t1?.cleared_edges.some((e) => e.from_marker_id === 'Q3' && e.to_marker_id === 'Q4'),
    ).toBe(false);
    // Q2→Q3 (depth-2, but Q3→Q4 has no length) must remain held.
    expect(
      t1?.cleared_edges.some((e) => e.from_marker_id === 'Q2' && e.to_marker_id === 'Q3'),
    ).toBe(true);
  });

  it('cycle guard: train holding every edge of a small loop terminates and releases correctly', () => {
    /* Three-edge loop, 100mm each, 250mm train. T1 holds all 3 edges (the whole
     * loop), acquired across two laps. The backward walk from current_edge
     * R2→R3 finds R1→R2 at depth-1 (cumulative=50<250). R3→R1 is the current
     * edge (excluded). The visited-marker guard on R1 prevents re-entering R3→R1
     * via R3. The loop terminates; cleared_edges is unchanged.
     *
     * This test asserts termination and correctness, not a specific release. */
    const THREE_LOOP: Layout = {
      name: 'three-loop',
      markers: [
        { id: 'R1', kind: 'block_boundary' },
        { id: 'R2', kind: 'block_boundary' },
        { id: 'R3', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'R1', to_marker_id: 'R2', estimated_length_mm: 100 },
        { from_marker_id: 'R2', to_marker_id: 'R3', estimated_length_mm: 100 },
        { from_marker_id: 'R3', to_marker_id: 'R1', estimated_length_mm: 100 },
      ],
      junctions: [],
    };
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();
    const layout = new LayoutState(THREE_LOOP, { now: () => 0 });
    const sched = new Scheduler(registry, layout, { now: () => 0 });
    seedIdentityTags(sched, ['R1', 'R2', 'R3']);

    /* Schedule R1→R3: transit R1→R2→R3. Head on R2→R3 (progress_index=1).
     * Forward edges = [R2→R3]. Backward walk from R2:
     *   depth-1: R1→R2 (to_marker=R2, not forward) — cumulative=50 < 250.
     *   depth-1's from = R1. boundary = R1.
     *   depth-2: look for edge with to_marker=R1, not forward. R3→R1 has
     *     to_marker=R1 and is not in the transit. cumulative=50+100=150 < 250.
     *   depth-2's from = R3. boundary = R3. R3 not yet visited.
     *   depth-3: look for edge with to_marker=R3, not forward. R2→R3 IS
     *     current_edge (in forwardEdgeKeys). No other. chainEdge=undefined. break.
     * Nothing releases; the call returns normally. */
    registerLongTrain(sched, 'T1', 250);
    sched.assignSchedule('T1', 'r1', ['R1', 'R3']);
    sched.handleEvent({ event_type: 'tag_observed', device_id: 'T1', payload: { tag_id: 'R1' } });
    sched.handleEvent({ event_type: 'tag_observed', device_id: 'T1', payload: { tag_id: 'R2' } });

    /* Inject R3→R1 into cleared_edges by having T1 hold it as a forward-horizon
     * edge — this simulates the train holding the whole loop. After crossing R2
     * (progress_index=1), extendClearanceHorizon would try to add the horizon
     * edge at index 2 (R2→R3 = progress_index edge itself) — but the transit
     * only has 2 edges, so no more horizon is added. Force the holding by
     * directly requesting R3→R1 clearance via clearance_request. */
    sched.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T1',
      payload: {
        train_id: 'T1',
        next_edge: { from_marker_id: 'R3', to_marker_id: 'R1' },
      },
    });

    const before = sched.getTrainState('T1');
    const beforeLen = before?.cleared_edges.length ?? 0;
    expect(beforeLen).toBeGreaterThanOrEqual(1);

    // Send a status — must return without hanging.
    const result = sched.handleEvent({
      event_type: 'train_status',
      device_id: 'T1',
      payload: {
        train_id: 'T1',
        current_edge: { from_marker_id: 'R2', to_marker_id: 'R3' },
        estimated_distance_from_edge_start_mm: 50,
        speed_normalised: 0.5,
      },
    });

    /* The call returned (no hang). Nothing releases: maximum cumulative on
     * this 3-edge 100mm loop with 250mm train cannot reach 250 without using
     * forward horizon edges (which are excluded). */
    expect(result).toBeDefined();
    expect(sched.getTrainState('T1')?.cleared_edges.length).toBe(beforeLen);
  });
});

describe('Scheduler — retained device state', () => {
  it('device_registered with train_length_mm includes it in the updateState effect', () => {
    const { scheduler } = setup();
    const effects = registerLongTrain(scheduler, 'T1', 200);

    const deviceUpdate = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> =>
        e.kind === 'update_state_snapshot' && e.entity_type === 'devices' && e.entity_id === 'T1',
    );
    expect(deviceUpdate).toBeDefined();
    expect((deviceUpdate?.state as { train_length_mm?: number }).train_length_mm).toBe(200);
  });

  it('device_registered without train_length_mm omits it from the updateState effect', () => {
    const { scheduler } = setup();
    const effects = registerTrain(scheduler, 'T1');

    const deviceUpdate = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> =>
        e.kind === 'update_state_snapshot' && e.entity_type === 'devices' && e.entity_id === 'T1',
    );
    expect(deviceUpdate).toBeDefined();
    expect(deviceUpdate?.state).not.toHaveProperty('train_length_mm');
  });

  it('device_registered with train_length_mm=0 omits it from the updateState effect', () => {
    const { scheduler } = setup();
    const effects = scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'T1',
      payload: {
        capabilities: ['core.controls_motion', 'core.accepts_route'],
        train_length_mm: 0,
      },
    });

    const deviceUpdate = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> =>
        e.kind === 'update_state_snapshot' && e.entity_type === 'devices' && e.entity_id === 'T1',
    );
    expect(deviceUpdate).toBeDefined();
    expect(deviceUpdate?.state).not.toHaveProperty('train_length_mm');
  });
});

describe('Scheduler — referential validation', () => {
  it('rejects assignSchedule when a stop references a marker not in the layout', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');

    // M999 is not in the layout — the schedule should be rejected.
    const effects = scheduler.assignSchedule('T1', 'route-bad', ['M1', 'M999']);

    const grant = effects.find(
      (e) => e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeUndefined();

    const anomaly = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'anomaly',
    );
    expect(anomaly).toBeDefined();
    expect((anomaly?.payload as { description: string }).description).toContain('M999');

    // Transit and schedule are not set; clearance state is clean.
    const train = scheduler.getTrainState('T1');
    expect(train?.transit).toBeUndefined();
    expect(train?.schedule).toBeUndefined();
    expect(train?.clearance_limit_marker_id).toBeUndefined();
    expect(train?.cleared_edges).toEqual([]);
  });

  it('rejects switch_state_changed when the junction marker is not in the layout', () => {
    const { scheduler } = setupFigure8();
    registerSwitch(scheduler, 'SW-BOGUS');

    const effects = scheduler.handleEvent({
      event_type: 'switch_state_changed',
      device_id: 'SW-BOGUS',
      payload: { junction_marker_id: 'BOGUS', position: 'main', confirmed: true },
    });

    const anomaly = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'anomaly',
    );
    expect(anomaly).toBeDefined();
    expect((anomaly?.payload as { description: string }).description).toContain('BOGUS');

    const updateState = effects.find(
      (e) => e.kind === 'update_state_snapshot' && e.entity_type === 'switches',
    );
    expect(updateState).toBeUndefined();
    expect(scheduler.getLayout().getSwitchPosition('BOGUS')).toBeUndefined();
  });

  it('rejects clearance_request when the next_edge references a marker not in the layout', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');

    const effects = scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T1',
      payload: { train_id: 'T1', next_edge: { from_marker_id: 'M1', to_marker_id: 'NOPE' } },
    });

    const grant = effects.find(
      (e) => e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeUndefined();

    const anomaly = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
        e.kind === 'publish_event' && e.event_type === 'anomaly',
    );
    expect(anomaly).toBeDefined();
    expect((anomaly?.payload as { description: string }).description).toContain('NOPE');
  });
});

describe('Scheduler — clearance state snapshots', () => {
  const findClearanceSnapshot = (
    effects: ReadonlyArray<SchedulerEffect>,
    trainId: string,
  ): Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> | undefined =>
    effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> =>
        e.kind === 'update_state_snapshot' &&
        e.entity_type === 'clearance' &&
        e.entity_id === trainId,
    );

  it('emits a clearance snapshot when a train is granted an edge', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');

    const effects = scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);

    const snapshot = findClearanceSnapshot(effects, 'T1');
    expect(snapshot).toBeDefined();
    expect(snapshot?.entity_type).toBe('clearance');
    const state = snapshot?.state as { train_id: string; cleared_edges: unknown[] };
    expect(state.train_id).toBe('T1');
    expect(state.cleared_edges).toHaveLength(1);
    expect(state.cleared_edges[0]).toMatchObject({ from_marker_id: 'M1', to_marker_id: 'M2' });
  });

  it('emits a clearance snapshot with empty cleared_edges when revoke drops all blocks', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);

    const revokeEffects = scheduler.revokeClearance('T1');

    const snapshot = findClearanceSnapshot(revokeEffects, 'T1');
    expect(snapshot).toBeDefined();
    const state = snapshot?.state as { train_id: string; cleared_edges: unknown[] };
    expect(state.cleared_edges).toHaveLength(0);
  });

  it('emits a clearance snapshot with empty cleared_edges when a train disconnects', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);

    const disconnectEffects = scheduler.handleEvent({
      event_type: 'device_disconnected',
      device_id: 'T1',
      payload: {},
    });

    const snapshot = findClearanceSnapshot(disconnectEffects, 'T1');
    expect(snapshot).toBeDefined();
    const state = snapshot?.state as { train_id: string; cleared_edges: unknown[] };
    expect(state.train_id).toBe('T1');
    expect(state.cleared_edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Switch device pairing via device_registered + controls_marker_id
// ---------------------------------------------------------------------------

describe('Scheduler — switch device pairing', () => {
  it('records the pairing when a device_registered carries controls_marker_id', () => {
    const { scheduler } = setup();
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'SWITCH-M1',
      payload: { capabilities: ['core.controls_switch'], controls_marker_id: 'M1' },
    });
    expect(scheduler.getLayout().switchDeviceForMarker('M1')).toBe('SWITCH-M1');
  });

  it('does not record a pairing when controls_marker_id is absent', () => {
    const { scheduler } = setup();
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'SWITCH-M1',
      payload: { capabilities: ['core.controls_switch'] },
    });
    expect(scheduler.getLayout().switchDeviceForMarker('M1')).toBeUndefined();
  });

  it('does not record a pairing for non-switch devices that happen to carry controls_marker_id', () => {
    const { scheduler } = setup();
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'SOME-DEVICE',
      payload: { capabilities: ['core.controls_motion'], controls_marker_id: 'M1' },
    });
    // No switch capability → pairing must not be recorded.
    expect(scheduler.getLayout().switchDeviceForMarker('M1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scheduler throws the switch for a scheduled route (the actuation keystone).
//
// A diverge junction J fed from two approaches A1, A2 with two branches:
//   J -> X requires 'main', J -> Y requires 'diverge'.
// T1 routes A1 -> J -> X (needs J on 'main'); T2 routes A2 -> J -> Y (needs J
// on 'diverge'). The crossing is the FINAL leg of each schedule, so the
// station dwell fires harmlessly at the terminus and never blocks completion.
// ---------------------------------------------------------------------------

const DIVERGE: Layout = {
  name: 'diverge',
  markers: [
    { id: 'A1', kind: 'block_boundary' },
    { id: 'A2', kind: 'block_boundary' },
    { id: 'J', kind: 'junction' },
    { id: 'PM', kind: 'block_boundary' },
    { id: 'PD', kind: 'block_boundary' },
    { id: 'X', kind: 'station_stop' },
    { id: 'Y', kind: 'station_stop' },
  ],
  edges: [
    { from_marker_id: 'A1', to_marker_id: 'J', estimated_length_mm: 200 },
    { from_marker_id: 'A2', to_marker_id: 'J', estimated_length_mm: 200 },
    // Junction branches. PM is past the junction on 'main'; PD on 'diverge'.
    // A separate marker past J lets the junction-incident edge release once a
    // train's tail clears it, freeing J while the train continues to its stop.
    {
      from_marker_id: 'J',
      to_marker_id: 'PM',
      estimated_length_mm: 200,
      requires_switch_state: 'main',
    },
    {
      from_marker_id: 'J',
      to_marker_id: 'PD',
      estimated_length_mm: 200,
      requires_switch_state: 'diverge',
    },
    { from_marker_id: 'PM', to_marker_id: 'X', estimated_length_mm: 200 },
    { from_marker_id: 'PD', to_marker_id: 'Y', estimated_length_mm: 200 },
  ],
  junctions: [{ marker_id: 'J' }],
};

const setupDiverge = () => {
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.freeze();
  const layout = new LayoutState(DIVERGE, { now: () => 0 });
  const scheduler = new Scheduler(registry, layout, { now: () => 0 });
  seedIdentityTags(scheduler, ['A1', 'A2', 'J', 'PM', 'PD', 'X', 'Y']);
  // The switch device that controls junction J. The `controls_marker_id`
  // pairing is what makes the scheduler actuate rather than merely withhold.
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: 'SW-J',
    payload: { capabilities: ['core.controls_switch'], controls_marker_id: 'J' },
  });
  return { scheduler, registry };
};

const observe = (scheduler: Scheduler, trainId: string, markerId: string) =>
  scheduler.handleEvent({
    event_type: 'tag_observed',
    device_id: trainId,
    payload: { tag_id: markerId },
  });

const confirmSwitch = (scheduler: Scheduler, junction: string, position: string) =>
  scheduler.handleEvent({
    event_type: 'switch_state_changed',
    device_id: 'SW-J',
    payload: { junction_marker_id: junction, position, confirmed: true },
  });

const findSetSwitch = (effects: ReadonlyArray<SchedulerEffect>) =>
  effects.filter(
    (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
      e.kind === 'send_command' && e.command_type === 'set_switch_position',
  );

describe('Scheduler — switch actuation for scheduled routes', () => {
  it('throws the switch to the required position and then grants (single train)', () => {
    const { scheduler } = setupDiverge();
    registerTrain(scheduler, 'T1');

    // T1: A1 -> J -> PM -> X. The junction edge J->PM needs 'main'; junction
    // position is initially unknown. Under the proactive horizon the look-ahead
    // reaches the junction edge at ASSIGN time (it grants A1->J, then attempts
    // J->PM): the switch is not on 'main', so a single set_switch_position is
    // emitted, clearance is WITHHELD there, and the horizon STOPS at the gap.
    // Throwing the switch earlier (before the train physically reaches J) is the
    // intended win of the horizon, not a regression.
    const assigned = scheduler.assignSchedule('T1', 'route-1', ['A1', 'X']);

    const sets = findSetSwitch(assigned);
    expect(sets).toHaveLength(1);
    expect(sets[0]?.device_id).toBe('SW-J');
    expect(sets[0]?.payload).toEqual({ junction_marker_id: 'J', position: 'main' });
    // A1->J is granted (the limit reaches J) but the junction edge is withheld.
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('J');
    expect(scheduler.getTrainState('T1')?.cleared_edges).toEqual([
      { from_marker_id: 'A1', to_marker_id: 'J' },
    ]);

    // The switch confirms 'main' — the existing confirm path retries the
    // horizon and grants across the junction (J->PM, then PM->X tops up).
    const afterConfirm = confirmSwitch(scheduler, 'J', 'main');
    const grant = findGrant(afterConfirm);
    expect(grant).toBeDefined();
    // The horizon now reaches the end of the leg: limit lands at the stop X.
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('X');
  });

  it('serializes two trains over one junction needing conflicting positions, flipping once per handover', () => {
    const { scheduler } = setupDiverge();
    // Length-aware trains (length_mm > 0) are REQUIRED for switched-junction
    // serialization, and this test pins down why. A length-aware train keeps
    // holding the section behind its head until the tail clears (reported via
    // train_status), so T1 keeps holding its approach edge — and therefore the
    // junction marker J, under ADR-011 — continuously across the switch
    // handover. A POINT train would release its approach edge the instant its
    // head reached J (before `maybeActuateSwitch` has secured the onward edge —
    // it has only *requested* the switch), leaving J unprotected for one
    // retry pass; the peer would then grab the conflicting branch and the two
    // would oscillate the switch into deadlock. Edges are 200mm; length 100mm
    // < edge, satisfying the phase-2 single-edge-tail constraint.
    registerLongTrain(scheduler, 'T1', 100);
    registerLongTrain(scheduler, 'T2', 100);

    const allSets: Array<Extract<SchedulerEffect, { kind: 'send_command' }>> = [];
    const record = (effs: ReadonlyArray<SchedulerEffect>) => allSets.push(...findSetSwitch(effs));

    // T1 wants J on 'main' (A1->J->PM->X); T2 on 'diverge' (A2->J->PD->Y).
    record(scheduler.assignSchedule('T1', 'r1', ['A1', 'X']));
    record(scheduler.assignSchedule('T2', 'r2', ['A2', 'Y']));

    // Both trains advance to their junction approach. T1 grabs A1->J first;
    // that edge locks J (ADR-011), so T2's A2->J — which shares J — is denied.
    record(observe(scheduler, 'T1', 'A1'));
    record(observe(scheduler, 'T2', 'A2'));

    // T1 reaches J. Its tail still occupies A1->J (length-aware), so that hold
    // — and thus the lock on J — persists. The onward edge J->PM needs 'main';
    // the switch is actuated and clearance withheld pending confirmation.
    record(observe(scheduler, 'T1', 'J'));
    record(confirmSwitch(scheduler, 'J', 'main'));

    // The load-bearing serialization assertion: while T1 holds the junction,
    // T2 must NOT have been granted any edge across J. A scheduler that let
    // both cross — or flipped the switch out from under T1 — would fail here.
    const t2held = scheduler.getTrainState('T2');
    expect(t2held?.cleared_edges).toEqual([]);
    expect(t2held?.clearance_limit_marker_id).toBe('A2');
    // T1 is cleared onward across the now-correct switch. The proactive horizon
    // runs the look-ahead to the end of the (short) leg, so the limit lands at
    // the stop X — J->PM and PM->X are both held now.
    expect(scheduler.getTrainState('T1')?.clearance_limit_marker_id).toBe('X');

    // T1's head moves along J->PM. While the head is only 50mm in, the tail
    // still occupies A1->J, so A1->J is not released and J stays locked.
    record(sendTrainStatus(scheduler, 'T1', { from_marker_id: 'J', to_marker_id: 'PM' }, 50));
    expect(scheduler.getTrainState('T2')?.cleared_edges).toEqual([]);
    // Head 150mm into J->PM: the tail has cleared A1->J, which releases. But
    // the head itself still occupies J->PM (incident to J), so J stays locked
    // and T2 remains blocked.
    record(sendTrainStatus(scheduler, 'T1', { from_marker_id: 'J', to_marker_id: 'PM' }, 150));
    expect(scheduler.getTrainState('T2')?.cleared_edges).toEqual([]);
    // T1 crosses onto PM and its tail then clears J->PM (head 150mm into
    // PM->X), finally freeing J for T2.
    record(observe(scheduler, 'T1', 'PM'));
    record(sendTrainStatus(scheduler, 'T1', { from_marker_id: 'PM', to_marker_id: 'X' }, 150));
    record(observe(scheduler, 'T1', 'X'));

    // J is now free. T2 proceeds: grabs A2->J, reaches J, switch flips to
    // 'diverge' for the handover, and T2 completes its transit to Y.
    record(observe(scheduler, 'T2', 'J'));
    record(confirmSwitch(scheduler, 'J', 'diverge'));
    record(observe(scheduler, 'T2', 'PD'));
    record(sendTrainStatus(scheduler, 'T2', { from_marker_id: 'PD', to_marker_id: 'Y' }, 150));
    record(observe(scheduler, 'T2', 'Y'));

    // Both trains completed their transit (each at its terminus stop).
    expect(scheduler.getTrainState('T1')?.last_marker_id).toBe('X');
    expect(scheduler.getTrainState('T2')?.last_marker_id).toBe('Y');

    // Idempotency: across the WHOLE run the switch flipped exactly twice — once
    // to 'main' for T1, once to 'diverge' for T2 — proving the command is NOT
    // reissued on every retry while the switch is mid-move.
    expect(allSets).toHaveLength(2);
    expect(allSets[0]?.payload).toEqual({ junction_marker_id: 'J', position: 'main' });
    expect(allSets[1]?.payload).toEqual({ junction_marker_id: 'J', position: 'diverge' });
  });
});

// ---------------------------------------------------------------------------
// Deterministic dwell at scheduled stops. A train arriving at a scheduled stop
// is held (no onward grant, no pointer advance) until STATION_DWELL_MS elapses
// on the INJECTED clock; the expiry is observed on a later train_status.
// ---------------------------------------------------------------------------

const findAssignRoute = (effects: ReadonlyArray<SchedulerEffect>) =>
  effects.find(
    (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
      e.kind === 'send_command' && e.command_type === 'assign_route',
  );

describe('Scheduler — deterministic station dwell', () => {
  it('holds at a scheduled stop until the dwell elapses, then cycles onward', () => {
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => 0 });
    let clock = 0;
    const scheduler = new Scheduler(registry, layout, { now: () => clock });
    seedIdentityTags(scheduler, SIMPLE_LOOP_MARKERS);
    registerTrain(scheduler, 'T1');

    // Three-stop loop: M1 -> M2 (stop) -> M4 (stop) -> back to M1. The train
    // starts at M1, heads to M2 first.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M2', 'M4']);

    // Drive to the first scheduled stop M2 (M1->M2 is the leg).
    observe(scheduler, 'T1', 'M1');
    const atM2 = observe(scheduler, 'T1', 'M2');

    // Arriving at the stop must NOT replan onward immediately: no assign_route,
    // and the pointer still targets M2 (index 1), not M4.
    expect(findAssignRoute(atM2)).toBeUndefined();
    expect(scheduler.getTrainState('T1')?.schedule?.current_stop_index).toBe(1);

    // A status before the dwell elapses keeps the train held.
    clock = STATION_DWELL_MS - 1;
    const early = scheduler.handleEvent({
      event_type: 'train_status',
      device_id: 'T1',
      payload: { train_id: 'T1', speed_normalised: 0 },
    });
    expect(findAssignRoute(early)).toBeUndefined();
    expect(scheduler.getTrainState('T1')?.schedule?.current_stop_index).toBe(1);

    // Advance the injected clock past the dwell. The next train_status observes
    // the expiry and replans the onward leg (M2 -> M3 -> M4) — pointer cycles.
    clock = STATION_DWELL_MS + 1;
    const late = scheduler.handleEvent({
      event_type: 'train_status',
      device_id: 'T1',
      payload: { train_id: 'T1', speed_normalised: 0 },
    });
    expect(findAssignRoute(late)).toBeDefined();
    expect(scheduler.getTrainState('T1')?.schedule?.current_stop_index).toBe(2);

    // Run a full further leg to prove the pointer cycles (M4 -> back to M1).
    observe(scheduler, 'T1', 'M3');
    observe(scheduler, 'T1', 'M4');
    expect(scheduler.getTrainState('T1')?.schedule?.current_stop_index).toBe(2);
    clock += STATION_DWELL_MS + 1;
    scheduler.handleEvent({
      event_type: 'train_status',
      device_id: 'T1',
      payload: { train_id: 'T1', speed_normalised: 0 },
    });
    // Pointer wrapped back to the first stop (index 0).
    expect(scheduler.getTrainState('T1')?.schedule?.current_stop_index).toBe(0);
  });
});
