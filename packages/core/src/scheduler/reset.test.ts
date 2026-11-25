import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES } from '../builtins/index.js';
import { CapabilityRegistry } from '../registry.js';
import type { SchedulerEffect } from './effects.js';
import { LayoutState } from './layout-state.js';
import { Scheduler } from './scheduler.js';

/**
 * `reset()` returns the scheduler to a freshly constructed state: every train,
 * device, tag, switch request and zone claim is forgotten, so a run started
 * after it behaves exactly like a run on a new scheduler.
 *
 * Layout: Z -> A -> J, then J -> PM (main) or J -> PD (diverge).
 */
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

const makeScheduler = (): Scheduler => {
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.freeze();
  const now = () => 0;
  return new Scheduler(registry, new LayoutState(JUNCTION, { now }), { now });
};

/** Bring up the tag writer, the switch and one train placed at A facing J, routed to PM. */
const populate = (scheduler: Scheduler, trainId: string): ReadonlyArray<SchedulerEffect> => {
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: 'GARAGE',
    payload: { capabilities: ['core.assigns_tags'] },
  });
  for (const m of JUNCTION.markers) {
    scheduler.handleEvent({
      event_type: 'tag_assignment',
      device_id: 'GARAGE',
      payload: { tag_id: m.id, assigned_kind: 'marker', target_id: m.id },
    });
  }
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: 'SW1',
    payload: { capabilities: ['core.controls_switch'], controls_marker_id: 'J' },
  });
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: trainId,
    payload: {
      capabilities: ['core.controls_motion', 'core.reports_marker_traversal', 'core.accepts_route'],
    },
  });
  scheduler.introduceTrainWithVector(trainId, { from_marker_id: 'A', to_marker_id: 'J' });
  return scheduler.assignSchedule(trainId, 'r', ['A', 'PM']);
};

const setSwitchCommands = (effs: ReadonlyArray<SchedulerEffect>) =>
  effs.filter((e) => e.kind === 'send_command' && e.command_type === 'set_switch_position');

describe('Scheduler.reset', () => {
  it('forgets every train, device and tag binding', () => {
    const scheduler = makeScheduler();
    populate(scheduler, 'T1');

    scheduler.reset();

    expect(scheduler.getTrainIds()).toEqual([]);
    expect(scheduler.getTrainState('T1')).toBeUndefined();
    expect(scheduler.getTagRegistry().resolve('A')).toBeUndefined();
    expect(scheduler.getLayout().switchDeviceForMarker('J')).toBeUndefined();
    const unknownTag = scheduler.handleEvent({
      event_type: 'tag_observed',
      device_id: 'T1',
      payload: { tag_id: 'A' },
    });
    expect(unknownTag).toEqual([
      {
        kind: 'publish_event',
        event_type: 'anomaly',
        payload: {
          severity: 'info',
          description: 'Unknown tag observed: A (not in the tag registry)',
        },
      },
    ]);
  });

  it('restarts the arrival order, so the first train after a reset ranks first', () => {
    const scheduler = makeScheduler();
    populate(scheduler, 'T1');

    scheduler.reset();
    populate(scheduler, 'T2');

    expect(scheduler.getTrainState('T2')?.registration_seq).toBe(0);
  });

  it('asks the switch again for a position it was asked for before the reset', () => {
    const scheduler = makeScheduler();
    expect(setSwitchCommands(populate(scheduler, 'T1'))).toHaveLength(1);

    scheduler.reset();

    expect(setSwitchCommands(populate(scheduler, 'T1'))).toHaveLength(1);
  });

  it('forgets the markers a zone frame owned', () => {
    const scheduler = makeScheduler();
    scheduler.handleEvent({
      event_type: 'device_registered',
      device_id: 'YARD',
      payload: { capabilities: ['core.gates_zone'], owned_marker_ids: ['PD'] },
    });
    expect(scheduler.ownerOfZoneMarker('PD')).toBe('YARD');

    scheduler.reset();

    expect(scheduler.ownerOfZoneMarker('PD')).toBeUndefined();
  });
});
