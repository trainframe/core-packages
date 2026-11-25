import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES } from '../builtins/index.js';
import { CapabilityRegistry } from '../registry.js';
import type { SchedulerEffect } from './effects.js';
import { LayoutState } from './layout-state.js';
import { SWITCH_ACTUATION_TIMEOUT_MS, Scheduler } from './scheduler.js';

/**
 * Regression tests for scheduler defects found by an audit of the clearance,
 * introduction, authority and device-lifecycle paths. Each test drives the real
 * scheduler through events and asserts on the effects and observable state.
 *
 * Layout: the four-marker loop M1 -> M2 -> M3 -> M4 -> M1.
 */
const LOOP: Layout = {
  name: 'loop',
  markers: ['M1', 'M2', 'M3', 'M4'].map((id) => ({ id, kind: 'block_boundary' as const })),
  edges: [
    ['M1', 'M2'],
    ['M2', 'M3'],
    ['M3', 'M4'],
    ['M4', 'M1'],
  ].map(([a = '', b = '']) => ({ from_marker_id: a, to_marker_id: b, estimated_length_mm: 200 })),
  junctions: [],
};

const makeScheduler = (layout: Layout = LOOP, now: () => number = () => 0): Scheduler => {
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.freeze();
  const scheduler = new Scheduler(registry, new LayoutState(layout, { now }), { now });
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

const registerTrain = (scheduler: Scheduler, trainId: string): void => {
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: trainId,
    payload: {
      capabilities: ['core.controls_motion', 'core.reports_marker_traversal', 'core.accepts_route'],
    },
  });
};

const tagObserved = (
  scheduler: Scheduler,
  trainId: string,
  markerId: string,
): ReadonlyArray<SchedulerEffect> =>
  scheduler.handleEvent({
    event_type: 'tag_observed',
    device_id: trainId,
    payload: { tag_id: markerId },
  });

const rollIntroduce = (scheduler: Scheduler, trainId: string, first: string, second: string) => {
  scheduler.introduceTrain(trainId);
  tagObserved(scheduler, trainId, first);
  return tagObserved(scheduler, trainId, second);
};

const heartbeat = (scheduler: Scheduler): ReadonlyArray<SchedulerEffect> =>
  scheduler.handleEvent({ event_type: 'heartbeat', device_id: 'GARAGE', payload: {} });

const grantsTo = (effs: ReadonlyArray<SchedulerEffect>, trainId: string) =>
  effs.filter(
    (e) =>
      e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === trainId,
  );

const findEvent = (effs: ReadonlyArray<SchedulerEffect>, eventType: string) =>
  effs.find((e) => e.kind === 'publish_event' && e.event_type === eventType);

describe('operator revoke holds until released', () => {
  it('an unrelated later event does not re-grant a revoked train', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    scheduler.assignSchedule('T1', 'r', ['M1', 'M3']);
    expect(scheduler.getTrainState('T1')?.cleared_edges.length).toBeGreaterThan(0);

    scheduler.revokeClearance('T1');
    const later = heartbeat(scheduler);

    expect(grantsTo(later, 'T1')).toEqual([]);
    expect(scheduler.getTrainState('T1')?.cleared_edges).toEqual([]);
  });

  it('a clearance_request from the revoked train is refused', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    scheduler.assignSchedule('T1', 'r', ['M1', 'M3']);
    scheduler.revokeClearance('T1');

    const effs = scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: 'T1',
      payload: { train_id: 'T1', next_edge: { from_marker_id: 'M1', to_marker_id: 'M2' } },
    });

    expect(grantsTo(effs, 'T1')).toEqual([]);
  });

  it('a fresh schedule from the operator releases the hold', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    scheduler.assignSchedule('T1', 'r', ['M1', 'M3']);
    scheduler.revokeClearance('T1');

    const effs = scheduler.assignSchedule('T1', 'r2', ['M1', 'M3']);

    expect(grantsTo(effs, 'T1').length).toBeGreaterThan(0);
  });
});

describe('introduction conflict leaves the train visible to block exclusivity', () => {
  /* T1 is introduced idle at M1, holding M4->M1. T2 is placed by operator vector
   * into the same section: an unresolvable overlap (ADR-036 section 5). */
  const conflictedSetup = () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    registerTrain(scheduler, 'T2');
    const effs = scheduler.introduceTrainWithVector('T2', {
      from_marker_id: 'M4',
      to_marker_id: 'M1',
    });
    return { scheduler, effs };
  };

  it('raises the conflict and keeps the train off the map, re-introducible', () => {
    const { scheduler, effs } = conflictedSetup();

    expect(findEvent(effs, 'train_introduction_conflict')).toBeDefined();
    expect(findEvent(effs, 'train_introduced')).toBeUndefined();
    const t2 = scheduler.getTrainState('T2');
    expect(t2?.introduced).toBeFalsy();
    expect(t2?.last_marker_id).toBeUndefined();
    expect(t2?.current_edge).toBeUndefined();

    const again = scheduler.introduceTrain('T2');
    expect(
      again.some((e) => e.kind === 'send_command' && e.command_type === 'introduce_train'),
    ).toBe(true);
  });

  it('holds the contested block so a third train stays out after the peer releases it', () => {
    const { scheduler, effs } = conflictedSetup();
    const published = effs.find(
      (e) =>
        e.kind === 'update_state_snapshot' && e.entity_type === 'clearance' && e.entity_id === 'T2',
    );
    expect(published?.kind === 'update_state_snapshot' && published.state).toEqual({
      train_id: 'T2',
      cleared_edges: [{ from_marker_id: 'M4', to_marker_id: 'M1' }],
    });

    registerTrain(scheduler, 'T3');
    rollIntroduce(scheduler, 'T3', 'M2', 'M3');
    scheduler.assignSchedule('T3', 'r3', ['M3', 'M1']);
    const afterPeerFrees = scheduler.revokeClearance('T1');

    expect(grantsTo(afterPeerFrees, 'T3')).toEqual([]);
    expect(scheduler.getTrainState('T3')?.cleared_edges).toEqual([]);
  });

  it('a pending schedule does not start on conflict', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    registerTrain(scheduler, 'T2');
    scheduler.assignSchedule('T2', 'r2', ['M1', 'M3']);

    const effs = scheduler.introduceTrainWithVector('T2', {
      from_marker_id: 'M4',
      to_marker_id: 'M1',
    });

    expect(effs.some((e) => e.kind === 'send_command' && e.device_id === 'T2')).toBe(false);
    expect(scheduler.getTrainState('T2')?.transit).toBeUndefined();
  });
});

describe('introduction conflict on a shared boundary marker', () => {
  it('a train placed at the marker a peer is heading into conflicts (operator vector)', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    registerTrain(scheduler, 'T2');

    const effs = scheduler.introduceTrainWithVector('T2', {
      from_marker_id: 'M1',
      to_marker_id: 'M2',
    });

    expect(findEvent(effs, 'train_introduction_conflict')).toBeDefined();
  });

  it('a train rolled up behind a peer that is pulling away from its marker does not conflict', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    scheduler.assignSchedule('T1', 'r1', ['M1', 'M3']);
    registerTrain(scheduler, 'T2');

    const effs = rollIntroduce(scheduler, 'T2', 'M4', 'M1');

    expect(findEvent(effs, 'train_introduction_conflict')).toBeUndefined();
  });

  it('a train resolving behind a peer whose clearance ends short of it does not conflict', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M1', 'M2');
    scheduler.assignSchedule('T1', 'r1', ['M2', 'M4']);
    registerTrain(scheduler, 'T2');

    const effs = rollIntroduce(scheduler, 'T2', 'M4', 'M1');

    expect(findEvent(effs, 'train_introduction_conflict')).toBeUndefined();
    expect(scheduler.getTrainState('T2')?.introduced).toBe(true);
  });
});

describe('clearance_request and train_status authority', () => {
  const request = (scheduler: Scheduler, deviceId: string, from: string, to: string) =>
    scheduler.handleEvent({
      event_type: 'clearance_request',
      device_id: deviceId,
      payload: { train_id: 'T1', next_edge: { from_marker_id: from, to_marker_id: to } },
    });

  it('ignores a clearance_request sent by a device other than the train', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');

    const effs = request(scheduler, 'GARAGE', 'M1', 'M2');

    expect(grantsTo(effs, 'T1')).toEqual([]);
    expect(scheduler.getTrainState('T1')?.cleared_edges).toEqual([
      { from_marker_id: 'M4', to_marker_id: 'M1' },
    ]);
  });

  it('refuses a requested edge that is not on the train route ahead of it', () => {
    const scheduler = makeScheduler();
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');

    const effs = request(scheduler, 'T1', 'M3', 'M4');

    expect(grantsTo(effs, 'T1')).toEqual([]);
    expect(findEvent(effs, 'anomaly')).toBeDefined();
  });

  it('never grants a route edge across an ungranted gap', () => {
    const scheduler = makeScheduler();
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'GATE-M1',
      payload: { capabilities: ['core.gates_clearance'] },
    });
    scheduler.handleEvent({
      event_type: 'gate_state_changed',
      device_id: 'GATE-M1',
      payload: { marker_id: 'M1', state: 'withholding', reason: 'test' },
    });
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M3', 'M4');
    scheduler.assignSchedule('T1', 'r', ['M4', 'M3']);
    /* T1 wants M4->M1, M1->M2, M2->M3; the gate withholds M1 so the horizon stops at once. */
    expect(scheduler.getTrainState('T1')?.cleared_edges).toEqual([]);

    const effs = request(scheduler, 'T1', 'M1', 'M2');

    expect(grantsTo(effs, 'T1')).toEqual([]);
    expect(scheduler.getTrainState('T1')?.cleared_edges).toEqual([]);
  });

  it('ignores a train_status for a train sent by another device', () => {
    const scheduler = makeScheduler();
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'T1',
      payload: {
        capabilities: [
          'core.controls_motion',
          'core.reports_marker_traversal',
          'core.accepts_route',
        ],
        train_length_mm: 150,
      },
    });
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    scheduler.assignSchedule('T1', 'r', ['M1', 'M4']);
    tagObserved(scheduler, 'T1', 'M2');
    const heldBefore = scheduler.getTrainState('T1')?.cleared_edges;
    expect(heldBefore).toContainEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });

    scheduler.handleEvent({
      event_type: 'train_status',
      device_id: 'GARAGE',
      payload: {
        train_id: 'T1',
        current_edge: { from_marker_id: 'M2', to_marker_id: 'M3' },
        estimated_distance_from_edge_start_mm: 190,
        speed_normalised: 0.5,
      },
    });

    expect(scheduler.getTrainState('T1')?.cleared_edges).toEqual(heldBefore);
  });
});

describe('a forgotten device drops its zone and switch bookkeeping', () => {
  const disconnect = (scheduler: Scheduler, deviceId: string) =>
    scheduler.handleEvent({ event_type: 'device_disconnected', device_id: deviceId, payload: {} });

  const registerZone = (scheduler: Scheduler, deviceId: string, payload: object = {}) =>
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: deviceId,
      payload: { capabilities: ['core.gates_zone'], ...payload },
    });

  it('releases the markers a vanished zone owned', () => {
    const scheduler = makeScheduler();
    registerZone(scheduler, 'Z', { owned_marker_ids: ['M3'] });
    disconnect(scheduler, 'Z');

    const effs = scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'SW',
      payload: { capabilities: ['core.controls_switch'], controls_marker_id: 'M3' },
    });

    expect(scheduler.ownerOfZoneMarker('M3')).toBeUndefined();
    expect(findEvent(effs, 'anomaly')).toBeUndefined();
  });

  it('forgets a vanished zone boundary, so routing to it is no longer zone admission', () => {
    const scheduler = makeScheduler();
    registerZone(scheduler, 'Z');
    scheduler.handleEvent({
      event_type: 'zone_state_changed',
      device_id: 'Z',
      payload: { zone_marker_id: 'M3', capacity: 2, occupancy: 0 },
    });
    disconnect(scheduler, 'Z');
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');

    const effs = scheduler.assignSchedule('T1', 'r', ['M1', 'M3']);

    expect(findEvent(effs, 'anomaly')).toBeUndefined();
    expect(grantsTo(effs, 'T1').length).toBeGreaterThan(0);
  });

  it('takes a train inside a vanished zone off the map until it is introduced again', () => {
    const scheduler = makeScheduler();
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'T1',
      payload: {
        capabilities: [
          'core.controls_motion',
          'core.reports_marker_traversal',
          'core.accepts_route',
          'core.can_reverse',
        ],
      },
    });
    rollIntroduce(scheduler, 'T1', 'M4', 'M1');
    registerZone(scheduler, 'Z');
    scheduler.handleEvent({
      event_type: 'zone_state_changed',
      device_id: 'Z',
      payload: { zone_marker_id: 'M3', capacity: 2, occupancy: 0 },
    });
    scheduler.assignSchedule('T1', 'r', ['M1', 'M3']);
    tagObserved(scheduler, 'T1', 'M2');
    tagObserved(scheduler, 'T1', 'M3');
    expect(scheduler.getTrainState('T1')?.in_zone).toBe('M3');

    const effs = disconnect(scheduler, 'Z');

    const t1 = scheduler.getTrainState('T1');
    expect(t1?.in_zone).toBeUndefined();
    expect(t1?.introduced).toBeFalsy();
    expect(t1?.last_marker_id).toBeUndefined();
    expect(findEvent(effs, 'anomaly')).toBeDefined();
    expect(
      effs.some(
        (e) =>
          e.kind === 'update_state_snapshot' &&
          e.entity_type === 'devices' &&
          e.entity_id === 'T1' &&
          (e.state as { introduced?: boolean }).introduced === undefined,
      ),
    ).toBe(true);
    expect(scheduler.introduceTrain('T1').some((e) => e.kind === 'send_command')).toBe(true);
  });
});

const JUNCTION: Layout = {
  name: 'junction',
  markers: [
    { id: 'A', kind: 'block_boundary' },
    { id: 'J', kind: 'junction' },
    { id: 'PM', kind: 'block_boundary' },
    { id: 'PD', kind: 'block_boundary' },
    { id: 'Z', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'Z', to_marker_id: 'A', estimated_length_mm: 200 },
    { from_marker_id: 'A', to_marker_id: 'J', estimated_length_mm: 200 },
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
  ],
  junctions: [{ marker_id: 'J' }],
};

const registerSwitch = (scheduler: Scheduler, deviceId: string) =>
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: deviceId,
    payload: { capabilities: ['core.controls_switch'], controls_marker_id: 'J' },
  });

const setSwitchCommands = (effs: ReadonlyArray<SchedulerEffect>) =>
  effs.filter((e) => e.kind === 'send_command' && e.command_type === 'set_switch_position');

describe('a forgotten switch device', () => {
  it('is no longer sent switch commands, and its replacement is', () => {
    const scheduler = makeScheduler(JUNCTION);
    registerSwitch(scheduler, 'SW1');
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'Z', 'A');
    const first = scheduler.assignSchedule('T1', 'r', ['A', 'PM']);
    expect(setSwitchCommands(first).map((e) => e.kind === 'send_command' && e.device_id)).toEqual([
      'SW1',
    ]);

    const afterLoss = scheduler.handleEvent({
      event_type: 'device_disconnected',
      device_id: 'SW1',
      payload: {},
    });
    expect(scheduler.getLayout().switchDeviceForMarker('J')).toBeUndefined();
    expect(setSwitchCommands(afterLoss)).toEqual([]);

    const afterReplacement = registerSwitch(scheduler, 'SW2');
    const retried = [...afterReplacement, ...heartbeat(scheduler)];
    expect(setSwitchCommands(retried).map((e) => e.kind === 'send_command' && e.device_id)).toEqual(
      ['SW2'],
    );
  });
});

describe('a reversed train', () => {
  /* Single-track corridor between two loops (the ADR-022 standoff layout). */
  const CORRIDOR: Layout = {
    name: 'corridor',
    markers: ['L1', 'L2', 'S1', 'SM', 'S2', 'R1', 'R2'].map((id) => ({
      id,
      kind: 'block_boundary' as const,
    })),
    edges: [
      ['L1', 'L2'],
      ['L2', 'S1'],
      ['S1', 'SM'],
      ['SM', 'S2'],
      ['S2', 'R1'],
      ['R1', 'R2'],
      ['R2', 'S2'],
      ['S2', 'SM'],
      ['SM', 'S1'],
      ['S1', 'L1'],
    ].map(([a = '', b = '']) => ({ from_marker_id: a, to_marker_id: b, estimated_length_mm: 200 })),
    junctions: [],
  };

  const registerLong = (scheduler: Scheduler, trainId: string) =>
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: trainId,
      payload: {
        capabilities: [
          'core.controls_motion',
          'core.reports_marker_traversal',
          'core.accepts_route',
          'core.can_reverse',
        ],
        train_length_mm: 100,
      },
    });

  /* T1 heads L->R and T2 R->L into the single track until they stand nose to
   * nose; the lowest-ranked train (T2) is reversed from S2 back to R2. */
  const standoff = () => {
    const scheduler = makeScheduler(CORRIDOR);
    registerLong(scheduler, 'T1');
    registerLong(scheduler, 'T2');
    rollIntroduce(scheduler, 'T1', 'L1', 'L2');
    rollIntroduce(scheduler, 'T2', 'S2', 'R1');
    scheduler.assignSchedule('T1', 'r1', ['L2', 'R1']);
    scheduler.assignSchedule('T2', 'r2', ['R1', 'L1']);
    tagObserved(scheduler, 'T2', 'R2');
    tagObserved(scheduler, 'T2', 'S2');
    tagObserved(scheduler, 'T1', 'S1');
    const last = tagObserved(scheduler, 'T1', 'SM');
    const reverse = last.find(
      (e) => e.kind === 'send_command' && e.command_type === 'grant_reverse',
    );
    expect(reverse?.kind === 'send_command' && reverse.device_id).toBe('T2');
    return scheduler;
  };

  it('must re-drive the block it backed out of before any block beyond it', () => {
    const scheduler = standoff();

    const t2 = scheduler.getTrainState('T2');
    expect(t2?.current_edge).toEqual({ from_marker_id: 'R2', to_marker_id: 'S2' });
    expect(t2?.transit?.edges[t2.transit.progress_index]).toEqual({
      from_marker_id: 'R2',
      to_marker_id: 'S2',
    });

    /* Once T1 is out of the way T2 is granted onward, starting at its own head. */
    scheduler.revokeClearance('T1');
    const held = scheduler.getTrainState('T2')?.cleared_edges ?? [];
    expect(held).toContainEqual({ from_marker_id: 'S2', to_marker_id: 'SM' });
    expect(held).toContainEqual({ from_marker_id: 'R2', to_marker_id: 'S2' });
  });

  it('records crossings made while backing up as reverse, never as forward traversals', () => {
    const scheduler = standoff();

    const effs = tagObserved(scheduler, 'T2', 'R2');

    const traversed = effs.find(
      (e) => e.kind === 'publish_event' && e.event_type === 'marker_traversed',
    );
    expect(traversed?.kind === 'publish_event' && traversed.payload).toMatchObject({
      marker_id: 'R2',
      direction: 'reverse',
    });
    const t2 = scheduler.getTrainState('T2');
    expect(t2?.transit?.progress_index).toBe(0);
    expect(t2?.cleared_edges).toContainEqual({ from_marker_id: 'R1', to_marker_id: 'R2' });
  });

  it('treats crossings as forward again once the reverse has ended', () => {
    const scheduler = standoff();
    tagObserved(scheduler, 'T2', 'R2');
    scheduler.revokeClearance('T1');

    const effs = tagObserved(scheduler, 'T2', 'S2');

    const traversed = effs.find(
      (e) => e.kind === 'publish_event' && e.event_type === 'marker_traversed',
    );
    expect(traversed?.kind === 'publish_event' && traversed.payload).toMatchObject({
      marker_id: 'S2',
      direction: 'forward',
    });
    expect(scheduler.getTrainState('T2')?.transit?.progress_index).toBe(1);
  });
});

describe('an unanswered switch command', () => {
  const waitingAtJunction = () => {
    let clock = 0;
    const scheduler = makeScheduler(JUNCTION, () => clock);
    registerSwitch(scheduler, 'SW1');
    registerTrain(scheduler, 'T1');
    rollIntroduce(scheduler, 'T1', 'Z', 'A');
    const first = scheduler.assignSchedule('T1', 'r', ['A', 'PM']);
    expect(setSwitchCommands(first)).toHaveLength(1);
    const status = (at: number) => {
      clock = at;
      return scheduler.handleEvent({
        event_type: 'train_status',
        device_id: 'T1',
        payload: { train_id: 'T1', speed_normalised: 0 },
      });
    };
    return { scheduler, status };
  };

  it('is not repeated while the switch still has time to answer', () => {
    const { status } = waitingAtJunction();

    expect(setSwitchCommands(status(SWITCH_ACTUATION_TIMEOUT_MS - 1))).toEqual([]);
  });

  it('is sent again once the switch has had its time, so the train is not stranded', () => {
    const { status } = waitingAtJunction();

    const resent = setSwitchCommands(status(SWITCH_ACTUATION_TIMEOUT_MS));

    expect(resent).toHaveLength(1);
    expect(resent[0]?.kind === 'send_command' && resent[0].payload).toEqual({
      junction_marker_id: 'J',
      position: 'main',
    });
    expect(setSwitchCommands(status(SWITCH_ACTUATION_TIMEOUT_MS + 1))).toEqual([]);
  });

  it('is not repeated once the switch confirms', () => {
    const { scheduler, status } = waitingAtJunction();
    scheduler.handleEvent({
      event_type: 'switch_state_changed',
      device_id: 'SW1',
      payload: { junction_marker_id: 'J', position: 'main', confirmed: true },
    });

    expect(setSwitchCommands(status(SWITCH_ACTUATION_TIMEOUT_MS * 3))).toEqual([]);
  });
});
