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

    const effects = scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

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
    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

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

    // Assign a route through M3.
    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

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
    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
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

    // T1 takes the M1→M2 edge.
    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    // T2 tries to take the same M1→M2 edge.
    const effects = scheduler.assignRoute('T2', 'route-2', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
    ]);

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

    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

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

    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

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

    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

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

    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

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

    scheduler.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
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
    scheduler.assignRoute('T1', 'route-1', [{ from_marker_id: 'M1', to_marker_id: 'M2' }]);

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

  it('publishes the assignment as retained state when tag_assignment lands', () => {
    const { scheduler } = setup();
    const effects = scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: { tag_id: 'TAG-NEW', assigned_kind: 'marker', target_id: 'M2' },
    });

    const snapshot = effects.find(
      (e): e is Extract<SchedulerEffect, { kind: 'update_state_snapshot' }> =>
        e.kind === 'update_state_snapshot' && e.entity_type === 'tags',
    );
    expect(snapshot).toBeDefined();
    expect(snapshot?.entity_id).toBe('TAG-NEW');
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
