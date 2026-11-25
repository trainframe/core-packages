import { Type } from '@sinclair/typebox';
import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES } from '../builtins/index.js';
import type { Capability } from '../capability.js';
import { CapabilityRegistry } from '../registry.js';
import type { SchedulerEffect } from './effects.js';
import { LayoutState } from './layout-state.js';
import { Scheduler } from './scheduler.js';

/**
 * A satellite actuator built only on the public hook surface: a turntable that
 * binds junction J at registration, rotates its deck when the scheduler asks,
 * and reports the deck locked through its own custom event. If the scheduler
 * can drive it the way it drives `core.controls_switch`, the built-in has no
 * privileged path.
 */
interface TurntableState {
  readonly aimed?: string | undefined;
  readonly asked_at?: number | undefined;
}

const DECK_LOCK_TIMEOUT_MS = 500;

const turntable: Capability<TurntableState> = {
  id: 'acme.turntable',
  description: 'A turntable deck that serves junction J.',
  customEvents: [
    { event_type: 'acme.deck_locked', payloadSchema: Type.Object({ deck: Type.String() }) },
  ],
  customCommands: [
    { command_type: 'acme.rotate', payloadSchema: Type.Object({ deck: Type.String() }) },
  ],
  stateSchema: Type.Object({}),
  initialState: () => ({}),
  hooks: {
    onEvent: (state, ctx) => {
      if (ctx.event_type === 'device_registered') {
        return {
          newState: state,
          intents: [
            {
              kind: 'bind_junction',
              junction_marker_id: 'J',
              valid_positions: ['main', 'diverge'],
            },
          ],
        };
      }
      if (ctx.event_type === 'acme.deck_locked') {
        const { deck } = ctx.payload as { deck: string };
        return {
          newState: { aimed: deck, asked_at: undefined },
          intents: [
            {
              kind: 'report_switch_position',
              junction_marker_id: 'J',
              position: deck,
              confirmed: true,
            },
          ],
        };
      }
      return { newState: state, intents: [] };
    },
    onActuationRequest: (state, request) => {
      const overdue =
        state.asked_at !== undefined && request.now_ms - state.asked_at >= DECK_LOCK_TIMEOUT_MS;
      if (state.aimed === request.position && !overdue) return { newState: state, intents: [] };
      return {
        newState: { aimed: request.position, asked_at: request.now_ms },
        intents: [
          {
            kind: 'send_command',
            device_id: request.device_id,
            command_type: 'acme.rotate',
            payload: { deck: request.position },
          },
        ],
      };
    },
    isActuationOverdue: (state, { now_ms }) =>
      state.asked_at !== undefined && now_ms - state.asked_at >= DECK_LOCK_TIMEOUT_MS,
  },
};

const JUNCTION: Layout = {
  name: 'junction',
  markers: [
    { id: 'Z', kind: 'block_boundary' },
    { id: 'A', kind: 'block_boundary' },
    { id: 'J', kind: 'junction' },
    { id: 'PM', kind: 'block_boundary' },
    { id: 'PD', kind: 'block_boundary' },
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

const tagObserved = (scheduler: Scheduler, trainId: string, markerId: string) =>
  scheduler.handleEvent({
    event_type: 'tag_observed',
    device_id: trainId,
    payload: { tag_id: markerId },
  });

/** A train T1 introduced at Z→A and a turntable TT serving J, on a clock the test drives. */
const turntableAtJunction = () => {
  let clock = 1_000;
  const now = () => clock;
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.register(turntable);
  registry.freeze();
  const scheduler = new Scheduler(registry, new LayoutState(JUNCTION, { now }), { now });
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
    device_id: 'TT',
    payload: { capabilities: ['acme.turntable'] },
  });
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: 'T1',
    payload: {
      capabilities: ['core.controls_motion', 'core.reports_marker_traversal', 'core.accepts_route'],
    },
  });
  scheduler.introduceTrain('T1');
  tagObserved(scheduler, 'T1', 'Z');
  tagObserved(scheduler, 'T1', 'A');
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

const rotations = (effs: ReadonlyArray<SchedulerEffect>) =>
  effs.filter((e) => e.kind === 'send_command' && e.command_type === 'acme.rotate');

const grantLimits = (effs: ReadonlyArray<SchedulerEffect>) =>
  effs.flatMap((e) =>
    e.kind === 'send_command' && e.command_type === 'grant_clearance' && e.device_id === 'T1'
      ? [(e.payload as { limit_marker_id: string }).limit_marker_id]
      : [],
  );

describe('a satellite actuator bound to a junction', () => {
  it('declares the junction it serves when it registers', () => {
    const { scheduler } = turntableAtJunction();

    expect(scheduler.getLayout().switchDeviceForMarker('J')).toBe('TT');
    expect(scheduler.getLayout().junctionMarkerIds()).toContain('J');
  });

  it('is asked to move the points when a route needs them, on the scheduler clock', () => {
    const { scheduler } = turntableAtJunction();

    const effs = scheduler.assignSchedule('T1', 'r', ['A', 'PM']);

    expect(rotations(effs)).toEqual([
      {
        kind: 'send_command',
        device_id: 'TT',
        command_type: 'acme.rotate',
        payload: { deck: 'main' },
      },
    ]);
    expect(grantLimits(effs)).not.toContain('PM');
    expect(scheduler.getDeviceCapabilityState('TT', 'acme.turntable')).toEqual({
      aimed: 'main',
      asked_at: 1_000,
    });
  });

  it('lets the train on once it reports the points in place', () => {
    const { scheduler } = turntableAtJunction();
    scheduler.assignSchedule('T1', 'r', ['A', 'PM']);
    tagObserved(scheduler, 'T1', 'J');

    const effs = scheduler.handleEvent({
      event_type: 'acme.deck_locked',
      device_id: 'TT',
      payload: { deck: 'main' },
    });

    expect(scheduler.getLayout().getSwitchPosition('J')).toBe('main');
    expect(grantLimits(effs)).toContain('PM');
  });

  it('is asked again once it says its move is overdue', () => {
    const { scheduler, status } = turntableAtJunction();
    scheduler.assignSchedule('T1', 'r', ['A', 'PM']);
    tagObserved(scheduler, 'T1', 'J');

    expect(rotations(status(1_000 + DECK_LOCK_TIMEOUT_MS - 1))).toEqual([]);
    expect(rotations(status(1_000 + DECK_LOCK_TIMEOUT_MS))).toHaveLength(1);
  });
});
