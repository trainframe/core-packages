import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES } from '../builtins/index.js';
import { CapabilityRegistry } from '../registry.js';
import type { SchedulerEffect } from './effects.js';
import { LayoutState } from './layout-state.js';
import { Scheduler } from './scheduler.js';

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
  const layout = new LayoutState(SIMPLE_LOOP);
  const scheduler = new Scheduler(registry, layout);
  seedIdentityTags(scheduler, SIMPLE_LOOP_MARKERS);
  return { scheduler, registry };
};

const registerTrain = (scheduler: Scheduler, trainId: string) =>
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: trainId,
    payload: { capabilities: ['core.controls_motion', 'core.accepts_route'] },
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

  it('extends clearance when a train arrives at its limit and more route remains', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    // Train starts at M1, heading to M3 via M1→M2→M3.
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);

    // Train passes M1 (the start) - then arrives at M2.
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
      (e): e is Extract<SchedulerEffect, { kind: 'send_command' }> =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance',
    );
    expect(grant).toBeDefined();
    expect((grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M3');
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

  it('releases a block when the holding train traverses past it, granting waiting trains', () => {
    const { scheduler } = setup();
    registerTrain(scheduler, 'T1');
    registerTrain(scheduler, 'T2');

    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    const t2Initial = scheduler.assignSchedule('T2', 'route-2', ['M1', 'M2']);
    // T2 starts blocked: transit assigned but no grant.
    expect(
      t2Initial.find((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance'),
    ).toBeUndefined();

    // T1 reaches M2 → finishes M1→M2 and the block should release. T2 was
    // waiting on M1→M2 with no other change, so the scheduler must retry its
    // grant in the same handler call.
    const effects = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'M2' },
    });
    const t2Grant = effects.find(
      (e) =>
        e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T2',
    );
    expect(t2Grant).toBeDefined();
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

    // T1 takes M1→M2 (gets initial clearance).
    scheduler.assignSchedule('T1', 'route-1', ['M1', 'M3']);
    expect(scheduler.getTrainState('T1')?.cleared_edges).toHaveLength(1);

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
  const layout = new LayoutState(FIGURE_8);
  const scheduler = new Scheduler(registry, layout);
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

    // Planner picks M1→M2→M3 (cheaper). Switch is 'main', matching M2→M3.
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

    const grant = findGrant(atM2);
    expect(grant).toBeDefined();
    expect((grant?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M3');
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
    const layout = new LayoutState(SIMPLE_LOOP, { confirmTraversals: 1 });
    const scheduler = new Scheduler(registry, layout);
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
