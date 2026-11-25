/**
 * ADR-036 Train Introduction lifecycle tests.
 *
 * These tests drive the scheduler through its REAL event interface — no mocks,
 * no internal state inspection beyond what getTrainState() exposes. They cover:
 *
 * 1. A not-yet-introduced train: schedule accepted but NO clearance granted.
 * 2. Roll path (§3a): introduceTrain() + two marker crossings → introduced,
 *    train_introduced emitted, roll ended (revoke_clearance), pending schedule starts.
 * 3. Zone path (§3b): incoming train_introduced event resolves vector with no
 *    roll; idempotent on a second/echoed event.
 * 4. §5 escalation: resolved into an occupied block → train_introduction_conflict,
 *    no schedule start.
 * 5. §5 resolvable: resolved clear of peers → no escalation, peer ahead just
 *    waits via ordinary clearance.
 */

import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES } from '../builtins/index.js';
import { CapabilityRegistry } from '../registry.js';
import type { SchedulerEffect } from './effects.js';
import { LayoutState } from './layout-state.js';
import { Scheduler } from './scheduler.js';

/* ---------- layouts ---------- */

/**
 * A simple 4-marker loop with identity tags:
 *   M1 -- M2 -- M3 -- M4 -- M1
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

/* ---------- setup helpers ---------- */

const makeScheduler = (layout: Layout = SIMPLE_LOOP, now: () => number = () => 0) => {
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.freeze();
  const ls = new LayoutState(layout, { now });
  const scheduler = new Scheduler(registry, ls, { now });
  /* Seed identity tags: marker_id === tag_id, simplifies event construction. */
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: 'GARAGE',
    payload: { capabilities: ['core.assigns_tags'] },
  });
  for (const m of layout.markers) {
    scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: { tag_id: m.id, assigned_kind: 'marker', target_id: m.id },
    });
  }
  return scheduler;
};

const registerTrain = (scheduler: Scheduler, trainId: string) =>
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: trainId,
    payload: {
      capabilities: ['core.controls_motion', 'core.reports_marker_traversal', 'core.accepts_route'],
    },
  });

const tagObserved = (scheduler: Scheduler, trainId: string, markerId: string) =>
  scheduler.handleEvent({
    event_type: 'tag_observed',
    device_id: trainId,
    payload: { tag_id: markerId },
  });

/* Register a zone that declares core.provides_train_heading — the only device
 * kind the scheduler will honour a train_introduced event from (ADR-036 §3b). */
const registerHeadingZone = (scheduler: Scheduler, deviceId: string) =>
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: deviceId,
    payload: { capabilities: ['core.provides_train_heading'] },
  });

/* Emit a train_introduced event AS a given emitter device. */
const emitTrainIntroduced = (
  scheduler: Scheduler,
  emitterDeviceId: string,
  trainId: string,
  markerId: string,
  headingEdge: { from_marker_id: string; to_marker_id: string },
): ReadonlyArray<SchedulerEffect> =>
  scheduler.handleEvent({
    event_type: 'train_introduced',
    device_id: emitterDeviceId,
    payload: { train_id: trainId, marker_id: markerId, heading_edge: headingEdge },
  });

/* Simulate a complete two-marker introduction roll. Returns the effects from
 * the second crossing, which is when resolution occurs. */
const rollIntroduce = (
  scheduler: Scheduler,
  trainId: string,
  firstMarkerId: string,
  secondMarkerId: string,
): ReadonlyArray<SchedulerEffect> => {
  scheduler.introduceTrain(trainId);
  tagObserved(scheduler, trainId, firstMarkerId); /* first crossing — no resolution yet */
  return tagObserved(scheduler, trainId, secondMarkerId); /* second crossing — resolution */
};

/* Find an effect by kind + optional discriminators. */
const findCommand = (
  effs: ReadonlyArray<SchedulerEffect>,
  commandType: string,
  deviceId?: string,
): Extract<SchedulerEffect, { kind: 'send_command' }> | undefined =>
  effs.find(
    (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
      e.kind === 'send_command' &&
      e.command_type === commandType &&
      (deviceId === undefined || e.device_id === deviceId),
  );

const findEvent = (
  effs: ReadonlyArray<SchedulerEffect>,
  eventType: string,
): Extract<SchedulerEffect, { kind: 'publish_event' }> | undefined =>
  effs.find(
    (e): e is Extract<SchedulerEffect, { kind: 'publish_event' }> =>
      e.kind === 'publish_event' && e.event_type === eventType,
  );

const findStateUpdate = (
  effs: ReadonlyArray<SchedulerEffect>,
  entityType: string,
  entityId?: string,
): Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> | undefined =>
  effs.find(
    (e): e is Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> =>
      e.kind === 'update_state_snapshot' &&
      e.entity_type === entityType &&
      (entityId === undefined || e.entity_id === entityId),
  );

/* ---------- tests ---------- */

describe('ADR-036 — registered-but-not-introduced train', () => {
  it('accepts a schedule but emits NO clearance grant (no routing before introduction)', () => {
    /* ADR-036 §4: schedule may be assigned to a not-yet-introduced train; it is
     * held pending. The scheduler refuses to plan while the vector is unknown. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    const effects = scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    /* Schedule is stored — a schedule-state snapshot is published. */
    const schedSnap = findStateUpdate(effects, 'schedule', 'T1');
    expect(schedSnap).toBeDefined();

    /* But NO grant_clearance and NO assign_route commands are emitted. */
    const grant = findCommand(effects, 'grant_clearance');
    expect(grant).toBeUndefined();
    const assignRoute = findCommand(effects, 'assign_route');
    expect(assignRoute).toBeUndefined();

    /* Train still not introduced in state. */
    const state = scheduler.getTrainState('T1');
    expect(state?.introduced).toBeFalsy();
    expect(state?.transit).toBeUndefined();
  });

  it('introduceTrain emits introduce_train command and sets introducing = true', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    const effects = scheduler.introduceTrain('T1');

    /* Must emit the introduce_train command to the train. */
    const cmd = findCommand(effects, 'introduce_train', 'T1');
    expect(cmd).toBeDefined();

    /* State: introducing is set, not yet introduced. */
    const state = scheduler.getTrainState('T1');
    expect(state?.introducing).toBe(true);
    expect(state?.introduced).toBeFalsy();
  });

  it('introduceTrain is a no-op for an unknown train', () => {
    const scheduler = makeScheduler();
    const effects = scheduler.introduceTrain('NOBODY');
    expect(effects).toHaveLength(0);
  });

  it('introduceTrain is a no-op for an already-introduced train', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M1', 'M2'); /* introduce it */

    /* Calling again should return []. */
    const effects = scheduler.introduceTrain('T1');
    expect(effects).toHaveLength(0);
  });
});

describe('ADR-036 — two-marker roll introduction (§3a)', () => {
  it('first marker crossing during roll is recorded but does not resolve', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    scheduler.introduceTrain('T1');

    const effects = tagObserved(scheduler, 'T1', 'M1');

    /* No train_introduced event yet — first crossing only. */
    expect(findEvent(effects, 'train_introduced')).toBeUndefined();
    /* No revoke_clearance yet. */
    expect(findCommand(effects, 'revoke_clearance')).toBeUndefined();

    /* First marker is recorded in state. */
    const state = scheduler.getTrainState('T1');
    expect(state?.introduction_first_marker_id).toBe('M1');
    expect(state?.introduced).toBeFalsy();
  });

  it('re-reading the same marker during roll does not resolve (waits for a distinct second marker)', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    scheduler.introduceTrain('T1');
    tagObserved(scheduler, 'T1', 'M1'); /* first crossing */

    /* Re-read M1 — should be ignored (not resolved). */
    const effects = tagObserved(scheduler, 'T1', 'M1');
    expect(findEvent(effects, 'train_introduced')).toBeUndefined();
    const state = scheduler.getTrainState('T1');
    expect(state?.introduced).toBeFalsy();
    expect(state?.introduction_first_marker_id).toBe('M1');
  });

  it('second distinct marker crossing resolves the vector and ends the roll', () => {
    /* ADR-036 §3a: after crossing M1 then M2, the core establishes heading M1→M2,
     * sets introduced = true, emits train_introduced, and sends revoke_clearance. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    const resolutionEffects = rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* train_introduced event is emitted with correct payload. */
    const introduced = findEvent(resolutionEffects, 'train_introduced');
    expect(introduced).toBeDefined();
    const payload = introduced?.payload as {
      train_id: string;
      marker_id: string;
      heading_edge: { from_marker_id: string; to_marker_id: string };
    };
    expect(payload.train_id).toBe('T1');
    expect(payload.marker_id).toBe('M2');
    expect(payload.heading_edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });

    /* revoke_clearance is emitted to stop the roll. */
    const revoke = findCommand(resolutionEffects, 'revoke_clearance', 'T1');
    expect(revoke).toBeDefined();

    /* Train state is updated. */
    const state = scheduler.getTrainState('T1');
    expect(state?.introduced).toBe(true);
    expect(state?.introducing).toBeFalsy();
    expect(state?.introduction_first_marker_id).toBeUndefined();
    expect(state?.current_edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(state?.last_marker_id).toBe('M2');
  });

  it('retained device state carries introduced: true after roll resolution', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    const resolutionEffects = rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* An update_state_snapshot for the device should carry introduced: true. */
    const snap = findStateUpdate(resolutionEffects, 'devices', 'T1');
    expect(snap).toBeDefined();
    expect((snap?.state as { introduced?: boolean }).introduced).toBe(true);
  });

  it('pending schedule auto-starts the instant the roll resolves (ADR-036 §4)', () => {
    /* Scenario 2: schedule assigned BEFORE introduction; the train runs it the
     * moment the vector resolves. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    /* Assign schedule while not yet introduced — stored but NOT planned. */
    const assignEffects = scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    expect(findCommand(assignEffects, 'grant_clearance')).toBeUndefined();
    expect(findCommand(assignEffects, 'assign_route')).toBeUndefined();

    /* Now introduce the train. The second crossing should trigger planning. */
    const resolutionEffects = rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* assign_route is emitted as part of the auto-start. */
    const route = findCommand(resolutionEffects, 'assign_route', 'T1');
    expect(route).toBeDefined();

    /* Clearance is granted. */
    const grant = findCommand(resolutionEffects, 'grant_clearance', 'T1');
    expect(grant).toBeDefined();

    /* Train state reflects the active transit. */
    const state = scheduler.getTrainState('T1');
    expect(state?.transit).toBeDefined();
    expect(state?.introduced).toBe(true);
  });

  it('Scenario 2 (no orphan lock): a point train with a pending schedule auto-starts, drives clear, and does NOT permanently lock the introduction section', () => {
    /* Regression for the orphan-occupancy bug: on the auto-start path the resolved
     * block (behind the head) must NOT be seeded into cleared_edges — it would
     * never be released (the train never re-crosses its end marker going forward)
     * and would lock the introduction section against every peer forever. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    /* Pending schedule M2→M4 assigned BEFORE introduction. */
    scheduler.assignSchedule('T1', 'route-t1', ['M2', 'M4']);

    /* Roll-introduce T1 onto M1→M2 (lands at M2). Schedule auto-starts: plans
     * M2→M3→M4 and grants from those PLANNED edges — the resolved block M1→M2 is
     * NOT seeded as a standalone hold. */
    rollIntroduce(scheduler, 'T1', 'M1', 'M2');
    const afterStart = scheduler.getTrainState('T1');
    /* M1→M2 (behind the head) must NOT be held — that is the orphan the fix
     * prevents. */
    const holdsBehindHead = afterStart?.cleared_edges.some(
      (e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2',
    );
    expect(holdsBehindHead).toBeFalsy();

    /* T1 drives its route: cross M3 then M4 (point train releases each block as
     * its head leaves it). After M4, T1 has driven entirely clear of the M1→M2
     * introduction section. */
    tagObserved(scheduler, 'T1', 'M3');
    tagObserved(scheduler, 'T1', 'M4');

    /* A later peer T2 needs an edge through the introduction section. M4→M1 and
     * M1→M2 both touch M1; if M1→M2 were orphan-locked by T1, T2 would be denied
     * forever. It must be GRANTED. */
    registerTrain(scheduler, 'T2');
    rollIntroduce(scheduler, 'T2', 'M2', 'M3'); /* T2 introduced elsewhere, idle hold on M2→M3 */
    /* Route T2 M3→M4→M1→M2 (the schedule replaces its idle hold). Its horizon
     * reaches through the introduction section. */
    scheduler.assignSchedule('T2', 'route-t2', ['M3', 'M2']);
    /* The introduction section is FREE — T2 is granted clearance through it. */
    const t2HoldsIntroSection = scheduler
      .getTrainState('T2')
      ?.cleared_edges.some((e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2');
    expect(t2HoldsIntroSection).toBe(true);
  });

  it('a SINGLE crossing observes but does NOT introduce, route, or clear (one marker is not a vector)', () => {
    /* ADR-036: one marker says only "a train is here now" — it is not a heading.
     * A not-introduced, not-introducing train's FIRST crossing is observed
     * (position tracked, marker_traversed emitted, edges learned) but must NOT
     * introduce, route, or clear it: a vector needs TWO consecutive crossings. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    /* A pending schedule is stored but, while not introduced, never planned. */
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    /* A single observed crossing (no introduceTrain, no prior marker). */
    const effects = tagObserved(scheduler, 'T1', 'M1');

    /* OBSERVED: position advances, marker_traversed emitted. */
    expect(findEvent(effects, 'marker_traversed')).toBeDefined();
    const state = scheduler.getTrainState('T1');
    expect(state?.last_marker_id).toBe('M1');

    /* NOT introduced on one crossing; NOT routed; NOT cleared. */
    expect(findEvent(effects, 'train_introduced')).toBeUndefined();
    expect(state?.introduced).toBeFalsy();
    expect(state?.transit).toBeUndefined();
    expect(state?.cleared_edges).toHaveLength(0);
    expect(findCommand(effects, 'grant_clearance', 'T1')).toBeUndefined();
    expect(findCommand(effects, 'assign_route', 'T1')).toBeUndefined();
  });

  it('AUTO-INTRODUCE on two ordinary crossings (discovery/exploration path): vector established by driving, not a roll gesture', () => {
    /* ADR-036: a vector is established by ANY two consecutive crossings. A train
     * driven by exploration/learn (not the §3a introduce gesture) becomes
     * introduced on its SECOND valid traversal — covering the toy-table workflow
     * (drive with begin_exploration → schedule). The train is MOVING, so it is NOT
     * stopped (no revoke_clearance) and seeds NO occupancy. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    /* First crossing: observed, not yet introduced. */
    tagObserved(scheduler, 'T1', 'M1');
    expect(scheduler.getTrainState('T1')?.introduced).toBeFalsy();

    /* Second consecutive crossing M1→M2: a real edge → AUTO-INTRODUCE. */
    const effects = tagObserved(scheduler, 'T1', 'M2');

    /* train_introduced emitted with the discovered heading edge. */
    const introduced = findEvent(effects, 'train_introduced');
    expect(introduced).toBeDefined();
    expect((introduced?.payload as { heading_edge: unknown }).heading_edge).toEqual({
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    const state = scheduler.getTrainState('T1');
    expect(state?.introduced).toBe(true);
    expect(state?.current_edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(state?.last_marker_id).toBe('M2');

    /* MOVING train: NOT stopped, NO seeded occupancy. */
    expect(findCommand(effects, 'revoke_clearance', 'T1')).toBeUndefined();
    expect(state?.cleared_edges).toHaveLength(0);

    /* Fires exactly once: a third crossing does not re-introduce. */
    const third = tagObserved(scheduler, 'T1', 'M3');
    expect(findEvent(third, 'train_introduced')).toBeUndefined();
  });

  it('auto-introduce on two ordinary crossings STARTS a pending schedule', () => {
    /* The toy-table sequence: schedule assigned (held pending) while not
     * introduced; the train is then driven across two markers and, on becoming
     * introduced, its schedule auto-starts. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    /* Pending schedule from M2 (where the train lands after the two crossings). */
    scheduler.assignSchedule('T1', 'route-1', ['M2', 'M4']);

    tagObserved(scheduler, 'T1', 'M1');
    const effects = tagObserved(scheduler, 'T1', 'M2');

    /* Introduced and the pending schedule auto-started. */
    expect(scheduler.getTrainState('T1')?.introduced).toBe(true);
    expect(findCommand(effects, 'assign_route', 'T1')).toBeDefined();
    expect(scheduler.getTrainState('T1')?.transit).toBeDefined();
  });
});

describe('ADR-036 — zone-provided heading introduction (§3b)', () => {
  it('incoming train_introduced event resolves vector with no roll', () => {
    /* Scenario 3: a core.provides_train_heading zone emits train_introduced before
     * releasing the train — no blind motion needed. */
    const scheduler = makeScheduler();
    registerHeadingZone(scheduler, 'YARD');
    registerTrain(scheduler, 'T1');

    const effects = emitTrainIntroduced(scheduler, 'YARD', 'T1', 'M2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    /* The scheduler accepts the vector. */
    const state = scheduler.getTrainState('T1');
    expect(state?.introduced).toBe(true);
    expect(state?.current_edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(state?.last_marker_id).toBe('M2');

    /* Retained device state updated. */
    const snap = findStateUpdate(effects, 'devices', 'T1');
    expect(snap).toBeDefined();
    expect((snap?.state as { introduced?: boolean }).introduced).toBe(true);

    /* No revoke_clearance (the zone controls the train, not the roll path). */
    expect(findCommand(effects, 'revoke_clearance')).toBeUndefined();
    /* No train_introduced re-emitted (the zone emitted it; the scheduler doesn't echo). */
    expect(findEvent(effects, 'train_introduced')).toBeUndefined();
  });

  it('zone-provided heading auto-starts a pending schedule', () => {
    const scheduler = makeScheduler();
    registerHeadingZone(scheduler, 'YARD');
    registerTrain(scheduler, 'T1');

    /* Assign schedule while not introduced. */
    const assignEffects = scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    expect(findCommand(assignEffects, 'grant_clearance')).toBeUndefined();

    /* Zone emits train_introduced → schedule should auto-start. */
    const effects = emitTrainIntroduced(scheduler, 'YARD', 'T1', 'M2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    /* assign_route emitted because the schedule auto-starts. */
    const route = findCommand(effects, 'assign_route', 'T1');
    expect(route).toBeDefined();

    const state = scheduler.getTrainState('T1');
    expect(state?.transit).toBeDefined();
  });

  it('train_introduced from a device WITHOUT core.provides_train_heading is rejected (authority gate)', () => {
    /* A rogue device must not be able to hijack a train's vector. */
    const scheduler = makeScheduler();
    /* ROGUE declares only controls_switch — NOT provides_train_heading. */
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'ROGUE',
      payload: { capabilities: ['core.controls_switch'] },
    });
    registerTrain(scheduler, 'T1');

    const effects = emitTrainIntroduced(scheduler, 'ROGUE', 'T1', 'M2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    /* The event is ignored — the train is NOT introduced. */
    expect(effects).toHaveLength(0);
    expect(scheduler.getTrainState('T1')?.introduced).toBeFalsy();
  });

  it('train_introduced from an unregistered emitter is rejected (authority gate)', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    /* No device 'YARD' was ever registered. */
    const effects = emitTrainIntroduced(scheduler, 'YARD', 'T1', 'M2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });
    expect(effects).toHaveLength(0);
    expect(scheduler.getTrainState('T1')?.introduced).toBeFalsy();
  });

  it('train_introduced is idempotent: already-introduced train is a no-op', () => {
    /* The core's own roll-path emission echoes back as a train_introduced event.
     * This must not re-resolve (or double-emit retained state). */
    const scheduler = makeScheduler();
    registerHeadingZone(scheduler, 'YARD');
    registerTrain(scheduler, 'T1');

    /* First: introduce via roll (which emits train_introduced on the bus). */
    rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* Now feed the echo back as an event from a valid heading zone. */
    const effects = emitTrainIntroduced(scheduler, 'YARD', 'T1', 'M2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    /* No retained state update (already introduced — no-op). */
    const snap = findStateUpdate(effects, 'devices', 'T1');
    expect(snap).toBeUndefined();
    /* No conflict event. */
    expect(findEvent(effects, 'train_introduction_conflict')).toBeUndefined();
  });

  it('train_introduced for an unknown train is a no-op', () => {
    const scheduler = makeScheduler();
    registerHeadingZone(scheduler, 'YARD');
    const effects = emitTrainIntroduced(scheduler, 'YARD', 'GHOST', 'M2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });
    expect(effects).toHaveLength(0);
  });
});

describe('ADR-036 §5 — resolution into an occupied block (conflict escalation)', () => {
  it('CO-OCCUPATION: resolving into the SAME section a peer holds emits train_introduction_conflict and starts no schedule', () => {
    /* Scenario 5 (escalation): T2 is active and holds M1→M2. T1 resolves its
     * heading onto the SAME section M1→M2 — genuine co-occupation, escalate. */
    const scheduler = makeScheduler();
    registerHeadingZone(scheduler, 'YARD');

    /* T2: introduce at M4→M1 (parked at M1), then assign M1→M3 so it is granted
     * M1→M2 as its first held block. */
    registerTrain(scheduler, 'T2');
    scheduler.introduceTrain('T2');
    tagObserved(scheduler, 'T2', 'M4');
    tagObserved(scheduler, 'T2', 'M1');
    scheduler.assignSchedule('T2', 'route-t2', ['M1', 'M3']);
    /* Confirm T2 actually holds M1→M2. */
    const t2 = scheduler.getTrainState('T2');
    const t2HoldsM1M2 = t2?.cleared_edges.some(
      (e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2',
    );
    expect(t2HoldsM1M2).toBe(true);

    /* T1: register, then a heading zone resolves it ONTO M1→M2 (same section). */
    registerTrain(scheduler, 'T1');
    const effects = emitTrainIntroduced(scheduler, 'YARD', 'T1', 'M2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    /* train_introduction_conflict must be raised, naming both trains + the block. */
    const conflict = findEvent(effects, 'train_introduction_conflict');
    expect(conflict).toBeDefined();
    const conflictPayload = conflict?.payload as {
      train_id: string;
      conflicting_train_id: string;
      block_edge: { from_marker_id: string; to_marker_id: string };
    };
    expect(conflictPayload.train_id).toBe('T1');
    expect(conflictPayload.conflicting_train_id).toBe('T2');
    expect(conflictPayload.block_edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });

    /* No assign_route or grant_clearance for T1 — schedule must NOT start. */
    expect(findCommand(effects, 'assign_route', 'T1')).toBeUndefined();
    expect(findCommand(effects, 'grant_clearance', 'T1')).toBeUndefined();

    /* The unsafe vector is refused: T1 stays off the map (not introduced, no
     * transit) pending operator action, but it holds its resolved block as
     * occupancy so block exclusivity still keeps other trains out of it. */
    const t1 = scheduler.getTrainState('T1');
    expect(t1?.introduced).toBeFalsy();
    expect(t1?.transit).toBeUndefined();
    expect(t1?.cleared_edges).toEqual([{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
  });

  it('HEAD-ON: resolving onto the REVERSE of a peer-held edge escalates', () => {
    /* A bidirectional layout where T2 holds M2→M1 and T1 resolves onto M1→M2 —
     * head-on in the same physical section. Escalate. */
    const BIDI: Layout = {
      name: 'bidi-mini',
      markers: ['M1', 'M2', 'M3', 'M4'].map((id) => ({ id, kind: 'block_boundary' as const })),
      edges: [
        ['M1', 'M2'],
        ['M2', 'M3'],
        ['M3', 'M4'],
        ['M4', 'M1'],
      ].flatMap(([a, b]) => [
        { from_marker_id: a as string, to_marker_id: b as string, estimated_length_mm: 200 },
        { from_marker_id: b as string, to_marker_id: a as string, estimated_length_mm: 200 },
      ]),
      junctions: [],
    };
    const scheduler = makeScheduler(BIDI);
    registerHeadingZone(scheduler, 'YARD');

    /* T2: introduce at M3→M2 (parked at M2, heading M3→M2), assign M2→M1 so it
     * holds M2→M1. */
    registerTrain(scheduler, 'T2');
    scheduler.introduceTrain('T2');
    tagObserved(scheduler, 'T2', 'M3');
    tagObserved(scheduler, 'T2', 'M2');
    scheduler.assignSchedule('T2', 'route-t2', ['M2', 'M1']);
    const t2HoldsM2M1 = scheduler
      .getTrainState('T2')
      ?.cleared_edges.some((e) => e.from_marker_id === 'M2' && e.to_marker_id === 'M1');
    expect(t2HoldsM2M1).toBe(true);

    /* T1 resolves head-on onto M1→M2 (reverse of T2's held M2→M1). */
    registerTrain(scheduler, 'T1');
    const effects = emitTrainIntroduced(scheduler, 'YARD', 'T1', 'M2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    const conflict = findEvent(effects, 'train_introduction_conflict');
    expect(conflict).toBeDefined();
    expect((conflict?.payload as { conflicting_train_id: string }).conflicting_train_id).toBe('T2');
    expect(scheduler.getTrainState('T1')?.transit).toBeUndefined();
  });

  it('CO-OCCUPATION via roll path: roll resolution into the same section escalates and starts no schedule', () => {
    /* Same co-occupation as the first test but using the two-marker roll. */
    const scheduler = makeScheduler();

    /* T2: introduce at M4→M1, assign M1→M3 so it holds M1→M2. */
    registerTrain(scheduler, 'T2');
    scheduler.introduceTrain('T2');
    tagObserved(scheduler, 'T2', 'M4');
    tagObserved(scheduler, 'T2', 'M1');
    scheduler.assignSchedule('T2', 'route-t2', ['M1', 'M3']);
    const t2HoldsM1M2 = scheduler
      .getTrainState('T2')
      ?.cleared_edges.some((e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2');
    expect(t2HoldsM1M2).toBe(true);

    /* T1: register with a pending schedule, then roll-introduce ONTO M1→M2. */
    registerTrain(scheduler, 'T1');
    scheduler.assignSchedule('T1', 'route-t1', ['M2', 'M4']);
    const resolutionEffects = rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* Conflict raised. */
    expect(findEvent(resolutionEffects, 'train_introduction_conflict')).toBeDefined();
    /* No schedule auto-start for T1, and it holds no block. */
    expect(findCommand(resolutionEffects, 'assign_route', 'T1')).toBeUndefined();
    expect(findCommand(resolutionEffects, 'grant_clearance', 'T1')).toBeUndefined();
    const t1 = scheduler.getTrainState('T1');
    expect(t1?.introduced).toBeFalsy();
    expect(t1?.transit).toBeUndefined();
    expect(t1?.cleared_edges).toEqual([{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
  });
});

describe('ADR-036 §5 — resolution clear of peers (no escalation)', () => {
  it('resolving clear of an active peer does not escalate; T1 starts its schedule normally', () => {
    /* Scenario 4 (resolvable): T2 holds M3→M4. T1 resolves at M1→M2 — no shared
     * markers. No train_introduction_conflict. T1's schedule starts immediately. */
    const scheduler = makeScheduler();

    /* T2: introduce at M2→M3 then assign schedule, granting M3→M4. */
    registerTrain(scheduler, 'T2');
    scheduler.introduceTrain('T2');
    tagObserved(scheduler, 'T2', 'M2');
    tagObserved(scheduler, 'T2', 'M3');
    /* Single-stop schedule: T2 heads from M3 to M4. */
    scheduler.assignSchedule('T2', 'route-t2', ['M3', 'M4']);
    /* T2 holds M3→M4. Verify it's there and does not touch M1 or M2. */
    const t2 = scheduler.getTrainState('T2');
    expect(t2?.cleared_edges.length).toBeGreaterThan(0);
    const t2TouchesM1orM2 = t2?.cleared_edges.some(
      (e) =>
        e.from_marker_id === 'M1' ||
        e.to_marker_id === 'M1' ||
        e.from_marker_id === 'M2' ||
        e.to_marker_id === 'M2',
    );
    expect(t2TouchesM1orM2).toBeFalsy();

    /* T1: register, pending schedule M1→M3. */
    registerTrain(scheduler, 'T1');
    scheduler.assignSchedule('T1', 'route-t1', ['M1', 'M3']);

    /* Introduce T1 at M1→M2 — clear of T2's held blocks (T2 is at M4→M1). */
    const resolutionEffects = rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* NO train_introduction_conflict. */
    expect(findEvent(resolutionEffects, 'train_introduction_conflict')).toBeUndefined();

    /* T1 IS introduced and route is being planned. */
    expect(scheduler.getTrainState('T1')?.introduced).toBe(true);
    /* assign_route is emitted (schedule auto-started). */
    const route = findCommand(resolutionEffects, 'assign_route', 'T1');
    expect(route).toBeDefined();

    /* T1's transit is established — it is waiting for clearance via ordinary
     * block exclusivity (T2 holds M3→M4 which shares M3 with T1's next edge M2→M3).
     * This is the normal trailing-train wait — no escalation needed. */
    const t1State = scheduler.getTrainState('T1');
    expect(t1State?.transit).toBeDefined();

    /* T2 is unaffected — it still has its transit and clearance. */
    const t2After = scheduler.getTrainState('T2');
    expect(t2After?.introduced).toBe(true);
    expect(t2After?.cleared_edges.length).toBeGreaterThan(0);
  });

  it('TRAILING-FOLLOW (Scenario 4): resolving behind a peer in the block ahead does NOT escalate; the trailing train waits then gets its onward grant when the peer clears', () => {
    /* ADR §5 resolvable: T1 resolves onto M1→M2; peer T2 holds the ADJACENT-AHEAD
     * block M2→M3 (shares only M2). This is ordinary trailing contention — NOT a
     * conflict. Only the trailing train waits; T2 is unaffected. Once T2 clears
     * M2→M3, T1 gets its onward grant via normal block exclusivity. */
    const scheduler = makeScheduler();

    /* T2: introduce at M1→M2 (parked at M2), assign M2→M4. T2 is granted M2→M3
     * (the block immediately ahead of T1's resolved block). */
    registerTrain(scheduler, 'T2');
    scheduler.introduceTrain('T2');
    tagObserved(scheduler, 'T2', 'M1');
    tagObserved(scheduler, 'T2', 'M2');
    scheduler.assignSchedule('T2', 'route-t2', ['M2', 'M4']);
    const t2HoldsM2M3 = scheduler
      .getTrainState('T2')
      ?.cleared_edges.some((e) => e.from_marker_id === 'M2' && e.to_marker_id === 'M3');
    expect(t2HoldsM2M3).toBe(true);

    /* T1: register with a pending schedule M2→M4, then roll-introduce ONTO M1→M2
     * (first crossing M1, second M2 → heading M1→M2, parked at M2). */
    registerTrain(scheduler, 'T1');
    scheduler.assignSchedule('T1', 'route-t1', ['M2', 'M4']);
    const resolutionEffects = rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* NO escalation — adjacency (shared M2 only) is the resolvable trailing case. */
    expect(findEvent(resolutionEffects, 'train_introduction_conflict')).toBeUndefined();
    expect(scheduler.getTrainState('T1')?.introduced).toBe(true);

    /* T1's pending schedule started (transit established). It is waiting on its
     * first leg M2→M3, which T2 holds — so block exclusivity denies the grant and
     * T1 holds NO block yet. (With a pending schedule the resolved block is NOT
     * seeded as a standalone hold — the planned grant is the occupancy, and here
     * it is withheld until the peer clears. That avoids the orphan-lock a seeded
     * behind-the-head block would otherwise cause on the auto-start path.) */
    const t1 = scheduler.getTrainState('T1');
    expect(t1?.transit).toBeDefined();
    const t1HoldsM2M3 = t1?.cleared_edges.some(
      (e) => e.from_marker_id === 'M2' && e.to_marker_id === 'M3',
    );
    expect(t1HoldsM2M3).toBeFalsy();
    expect(t1?.cleared_edges).toHaveLength(0);

    /* T2 is unaffected. */
    expect(scheduler.getTrainState('T2')?.cleared_edges.length).toBeGreaterThan(0);

    /* Now T2 advances past M3 (crosses M3 then M4), releasing M2→M3. The retry in
     * that crossing then grants T1 the onward block it was waiting for. */
    tagObserved(scheduler, 'T2', 'M3');
    const afterClear = tagObserved(scheduler, 'T2', 'M4');
    const grantToT1 = afterClear.some(
      (e) =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T1',
    );
    const t1NowHoldsAhead = scheduler
      .getTrainState('T1')
      ?.cleared_edges.some((e) => e.from_marker_id === 'M2' && e.to_marker_id === 'M3');
    expect(grantToT1 || t1NowHoldsAhead).toBe(true);
  });

  it('Scenario 6: an active peer approaching the introduction point cannot be granted into the resolved block (block exclusivity holds the instant the vector resolves)', () => {
    /* The instant T1's vector resolves it HOLDS its resolved block M1→M2. An
     * active peer T2 approaching from M4 and wanting M4→M1 shares M1 with T1's
     * block, so block exclusivity must deny T2 — the just-introduced train is
     * protected from a peer rolling into the section it now sits in. */
    const scheduler = makeScheduler();

    /* T1: roll-introduce ONTO M1→M2 (first M1, second M2). It holds M1→M2. */
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M1', 'M2');
    const t1HoldsM1M2 = scheduler
      .getTrainState('T1')
      ?.cleared_edges.some((e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2');
    expect(t1HoldsM1M2).toBe(true);

    /* T2: an active peer approaching M1. Its route starts with M4→M1 (shares M1
     * with T1's held M1→M2) — block exclusivity must DENY it. */
    registerTrain(scheduler, 'T2');
    scheduler.introduceTrain('T2');
    tagObserved(scheduler, 'T2', 'M3');
    tagObserved(scheduler, 'T2', 'M4');
    const probe = scheduler.assignSchedule('T2', 'route-t2', ['M4', 'M2']);
    expect(findCommand(probe, 'assign_route', 'T2')).toBeDefined();
    expect(findCommand(probe, 'grant_clearance', 'T2')).toBeUndefined();
  });

  it('clearance_request from a not-yet-introduced train is ignored (defensive guard)', () => {
    /* Even if a train erroneously sends a clearance_request, the scheduler must
     * not grant clearance to a not-yet-introduced train. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    /* Assign a schedule (stored, not planned). */
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    /* Simulate a spurious clearance_request from T1. */
    const effects = scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T1',
      payload: {
        train_id: 'T1',
        next_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
      },
    });

    /* Must not grant clearance. */
    expect(findCommand(effects, 'grant_clearance', 'T1')).toBeUndefined();
    expect(scheduler.getTrainState('T1')?.cleared_edges).toHaveLength(0);
  });

  it('introduced train is cleared normally by regular routing after introduction', () => {
    /* After introduction completes the train enters ordinary routing — verify
     * the full cycle: introduce → assign_route → marker crossing → horizon top-up. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* Assign schedule from M2 (where the train is after the roll). */
    const schedEffects = scheduler.assignSchedule('T1', 'route-1', ['M2', 'M4']);

    /* Normal routing resumes: assign_route and clearance granted. */
    expect(findCommand(schedEffects, 'assign_route', 'T1')).toBeDefined();
    expect(findCommand(schedEffects, 'grant_clearance', 'T1')).toBeDefined();

    /* Crossing a marker tops up the clearance horizon (normal transit logic). */
    const crossEffects = tagObserved(scheduler, 'T1', 'M3');
    /* Some clearance effects should flow (either new grant or clearance state). */
    const hasEffect = crossEffects.some(
      (e) =>
        (e.kind === 'send_command' && e.command_type === 'grant_clearance') ||
        (e.kind === 'update_state_snapshot' && e.entity_type === 'clearance'),
    );
    expect(hasEffect).toBe(true);
  });

  it('marker_traversed OMITS inferred_edge on a re-read of the current marker (ADR-016 branch)', () => {
    /* Restores the ADR-016 "no inferred_edge when there is no completed edge"
     * coverage. With mandatory introduction a train always has a last_marker_id,
     * so the `previousMarker === undefined` first-traversal case is unreachable in
     * handleTrainAtMarker; the surviving way to hit the omit-branch is a RE-READ
     * of the current marker (previousMarker === markerId), which completes no edge.
     * The marker_traversed it emits must carry NO inferred_edge. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    /* Roll lands T1 at M2 (last_marker_id = 'M2'). */
    rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* Re-read M2 — the marker the train is already at. No edge is completed. */
    const effects = tagObserved(scheduler, 'T1', 'M2');
    const traversed = findEvent(effects, 'marker_traversed');
    expect(traversed).toBeDefined();
    expect(
      (traversed?.payload as { inferred_edge?: { from_marker_id: string; to_marker_id: string } })
        .inferred_edge,
    ).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* ADR-036 §3c — operator/placer-provided vector (introduceTrainWithVector)   */
/* -------------------------------------------------------------------------- */

describe('ADR-036 §3c — operator-provided vector introduction (introduceTrainWithVector)', () => {
  it('introduces a registered train immediately with the given heading, no roll, no revoke_clearance', () => {
    /* The canonical §3c case: the placer knows the facing and supplies it
     * directly. No introduce_train command is sent; no revoke_clearance fires;
     * train_introduced IS published so bus subscribers learn the vector. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    const effs = scheduler.introduceTrainWithVector('T1', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    /* No roll command or revoke. */
    expect(findCommand(effs, 'introduce_train')).toBeUndefined();
    expect(findCommand(effs, 'revoke_clearance')).toBeUndefined();

    /* train_introduced published with correct payload. */
    const introduced = findEvent(effs, 'train_introduced');
    expect(introduced).toBeDefined();
    const payload = introduced?.payload as {
      train_id: string;
      marker_id: string;
      heading_edge: { from_marker_id: string; to_marker_id: string };
    };
    expect(payload.train_id).toBe('T1');
    /* marker_id is set to headingEdge.from_marker_id (the train's position). */
    expect(payload.marker_id).toBe('M1');
    expect(payload.heading_edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });

    /* Retained device state carries introduced: true. */
    const snap = findStateUpdate(effs, 'devices', 'T1');
    expect(snap).toBeDefined();
    expect((snap?.state as { introduced?: boolean }).introduced).toBe(true);

    /* Train state reflects the committed vector. */
    const state = scheduler.getTrainState('T1');
    expect(state?.introduced).toBe(true);
    expect(state?.introducing).toBeFalsy();
    expect(state?.current_edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(state?.last_marker_id).toBe('M1');
  });

  it('is a no-op for an unknown train', () => {
    const scheduler = makeScheduler();
    const effs = scheduler.introduceTrainWithVector('NOBODY', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });
    expect(effs).toHaveLength(0);
  });

  it('is a no-op for an already-introduced train (idempotent)', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    /* First introduction via the roll path. */
    rollIntroduce(scheduler, 'T1', 'M1', 'M2');

    /* Second call with operator path must return []. */
    const effs = scheduler.introduceTrainWithVector('T1', {
      from_marker_id: 'M3',
      to_marker_id: 'M4',
    });
    expect(effs).toHaveLength(0);

    /* Heading unchanged from the roll introduction. */
    expect(scheduler.getTrainState('T1')?.current_edge).toEqual({
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });
  });

  it('pending schedule auto-starts the instant the operator vector resolves (§4)', () => {
    /* Schedule assigned BEFORE introduction; train runs it when the operator
     * supplies the vector — same §4 guarantee as the roll and zone paths. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    /* Assign schedule while not yet introduced — stored but NOT planned. */
    const assignEffects = scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    expect(findCommand(assignEffects, 'grant_clearance')).toBeUndefined();
    expect(findCommand(assignEffects, 'assign_route')).toBeUndefined();

    /* Operator introduces with a known vector. */
    const effs = scheduler.introduceTrainWithVector('T1', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    /* assign_route and clearance emitted — schedule auto-started. */
    expect(findCommand(effs, 'assign_route', 'T1')).toBeDefined();
    expect(findCommand(effs, 'grant_clearance', 'T1')).toBeDefined();

    /* State: transit active, introduced. */
    const state = scheduler.getTrainState('T1');
    expect(state?.introduced).toBe(true);
    expect(state?.transit).toBeDefined();
  });

  it('introduced train is routable by ordinary scheduling after operator vector introduction', () => {
    /* Full end-to-end: introduce → assignSchedule → marker crossings. */
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');

    scheduler.introduceTrainWithVector('T1', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    const schedEffects = scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    /* Ordinary routing: assign_route and clearance granted. */
    expect(findCommand(schedEffects, 'assign_route', 'T1')).toBeDefined();
    expect(findCommand(schedEffects, 'grant_clearance', 'T1')).toBeDefined();

    /* Crossing a marker tops up the horizon (normal transit logic). */
    const crossEffects = tagObserved(scheduler, 'T1', 'M2');
    const hasEffect = crossEffects.some(
      (e) =>
        (e.kind === 'send_command' && e.command_type === 'grant_clearance') ||
        (e.kind === 'update_state_snapshot' && e.entity_type === 'clearance'),
    );
    expect(hasEffect).toBe(true);
  });

  it('§5 conflict escalation applies to the operator path too (resolved into occupied block)', () => {
    /* T2 holds M1→M2. Operator introduces T1 onto the same section → escalate. */
    const scheduler = makeScheduler();

    registerTrain(scheduler, 'T2');
    scheduler.introduceTrain('T2');
    tagObserved(scheduler, 'T2', 'M4');
    tagObserved(scheduler, 'T2', 'M1');
    scheduler.assignSchedule('T2', 'route-t2', ['M1', 'M3']);
    const t2HoldsM1M2 = scheduler
      .getTrainState('T2')
      ?.cleared_edges.some((e) => e.from_marker_id === 'M1' && e.to_marker_id === 'M2');
    expect(t2HoldsM1M2).toBe(true);

    registerTrain(scheduler, 'T1');
    const effs = scheduler.introduceTrainWithVector('T1', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    /* Conflict raised, no schedule start, no clearance for T1. */
    expect(findEvent(effs, 'train_introduction_conflict')).toBeDefined();
    expect(findCommand(effs, 'assign_route', 'T1')).toBeUndefined();
    expect(findCommand(effs, 'grant_clearance', 'T1')).toBeUndefined();
    const t1 = scheduler.getTrainState('T1');
    expect(t1?.introduced).toBeFalsy();
    expect(t1?.transit).toBeUndefined();
    expect(t1?.cleared_edges).toEqual([{ from_marker_id: 'M1', to_marker_id: 'M2' }]);
  });
});
