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
