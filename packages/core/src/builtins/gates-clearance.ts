import { type Static, Type } from '@sinclair/typebox';
import type { Capability } from '../capability.js';

/**
 * The gates_clearance capability lets a device withhold clearance at one or
 * more markers. The scheduler consults all gates_clearance devices when
 * deciding whether to extend a train's clearance.
 *
 * State per device: a set of markers currently being withheld, plus reason
 * strings.
 *
 * This capability is the canonical example of how the platform is extensible.
 * If you understand how this is wired up, you can build any other capability.
 */

const GatesClearanceState = Type.Object({
  withheld_markers: Type.Array(
    Type.Object({
      marker_id: Type.String(),
      reason: Type.String(),
    }),
  ),
});

type State = Static<typeof GatesClearanceState>;

export const gatesClearanceCapability: Capability<State> = {
  id: 'core.gates_clearance',
  description:
    'A device that may withhold or grant clearance at specified markers. Stations, ' +
    'crane-gated stations, panic buttons, and any other "wait until …" mechanism ' +
    'declare this capability.',

  customEvents: [], // uses core gate_state_changed event
  customCommands: [], // uses core hold_gate / release_gate commands (not yet defined)

  stateSchema: GatesClearanceState,

  initialState: () => ({ withheld_markers: [] }),

  hooks: {
    onEvent: (state, ctx) => {
      // Only interested in gate_state_changed events.
      if (ctx.event_type !== 'gate_state_changed') {
        return { newState: state, intents: [] };
      }

      // The payload shape is validated upstream by the broker boundary;
      // we cast here for ergonomics. The stateSchema and event schemas
      // together guarantee shape correctness.
      const payload = ctx.payload as {
        marker_id: string;
        state: 'granting' | 'withholding';
        reason?: string;
      };

      if (payload.state === 'withholding') {
        const already = state.withheld_markers.some((w) => w.marker_id === payload.marker_id);
        if (already) {
          return { newState: state, intents: [] };
        }
        return {
          newState: {
            withheld_markers: [
              ...state.withheld_markers,
              { marker_id: payload.marker_id, reason: payload.reason ?? 'gated' },
            ],
          },
          intents: [],
        };
      }

      // state === 'granting'
      return {
        newState: {
          withheld_markers: state.withheld_markers.filter((w) => w.marker_id !== payload.marker_id),
        },
        intents: [],
      };
    },

    onClearanceConsultation: (state, request) => {
      // If the proposed new limit marker is one this device is withholding,
      // veto the clearance extension.
      const withhold = state.withheld_markers.find(
        (w) => w.marker_id === request.proposed_new_limit_marker_id,
      );
      if (withhold) {
        return { vote: 'deny', reason: `gated by device: ${withhold.reason}` };
      }
      return { vote: 'abstain' };
    },

    onDeviceDisconnect: (_state) => {
      // When a gating device disconnects, treat all its withholds as
      // released. Conservative alternative: keep them withheld until
      // operator intervention. We choose release here because a vanished
      // device that's holding a train hostage is a worse failure mode than
      // a brief unintended clearance extension.
      return {
        newState: { withheld_markers: [] },
        intents: [
          {
            kind: 'emit_anomaly',
            severity: 'warning',
            description: 'gates_clearance device disconnected; releasing all its withholds',
          },
        ],
      };
    },
  },
};
