/**
 * Example satellite capability: a turntable.
 *
 * A turntable is a rotating platform that swaps a train's facing direction.
 * It needs:
 *   - A "rotate" command from the server
 *   - A "rotation_complete" event back
 *   - The ability to gate clearance while rotating (a train must not enter
 *     a turntable that's mid-rotation)
 *
 * This file shows what a satellite package ships:
 *   - A Capability definition (its custom events, commands, state, hooks)
 *   - That Capability gets registered into the platform's registry at startup
 *
 * To use this in your own platform:
 *
 *     import { CapabilityRegistry, BUILTIN_CAPABILITIES } from '@trainframe/core';
 *     import { turntableCapability } from '@example/trainframe-turntable';
 *
 *     const registry = new CapabilityRegistry();
 *     registry.registerAll(BUILTIN_CAPABILITIES);
 *     registry.register(turntableCapability);
 *     registry.freeze();
 *
 * No changes to the core packages required.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { Capability } from '@trainframe/core';

// ---------- Custom events ----------

const RotationStarted = Type.Object({
  current_position_degrees: Type.Number({ minimum: 0, maximum: 360 }),
  target_position_degrees: Type.Number({ minimum: 0, maximum: 360 }),
});

const RotationComplete = Type.Object({
  final_position_degrees: Type.Number({ minimum: 0, maximum: 360 }),
});

// ---------- Custom commands ----------

const RotateToPosition = Type.Object({
  target_position_degrees: Type.Number({ minimum: 0, maximum: 360 }),
});

// ---------- State ----------

const TurntableState = Type.Object({
  current_position_degrees: Type.Number(),
  rotating: Type.Boolean(),
  /** Marker at which the turntable sits; clearance is gated here while rotating. */
  marker_id: Type.Optional(Type.String()),
});

type State = Static<typeof TurntableState>;

// ---------- Capability ----------

export const turntableCapability: Capability<State> = {
  id: 'com.example.controls_turntable',
  description:
    "Controls a rotating platform that swaps a train's facing direction. " +
    'Withholds clearance at its marker while rotating.',

  customEvents: [
    { event_type: 'rotation_started', payloadSchema: RotationStarted },
    { event_type: 'rotation_complete', payloadSchema: RotationComplete },
  ],

  customCommands: [{ command_type: 'rotate_to_position', payloadSchema: RotateToPosition }],

  stateSchema: TurntableState,

  initialState: () => ({
    current_position_degrees: 0,
    rotating: false,
  }),

  hooks: {
    onEvent: (state, ctx) => {
      if (ctx.event_type === 'rotation_started') {
        return {
          newState: { ...state, rotating: true },
          intents: [],
        };
      }
      if (ctx.event_type === 'rotation_complete') {
        const payload = ctx.payload as { final_position_degrees: number };
        return {
          newState: {
            ...state,
            rotating: false,
            current_position_degrees: payload.final_position_degrees,
          },
          intents: [],
        };
      }
      return { newState: state, intents: [] };
    },

    onClearanceConsultation: (state, request) => {
      if (
        state.rotating &&
        state.marker_id &&
        request.proposed_new_limit_marker_id === state.marker_id
      ) {
        return { vote: 'deny', reason: 'turntable rotating' };
      }
      return { vote: 'abstain' };
    },
  },
};
