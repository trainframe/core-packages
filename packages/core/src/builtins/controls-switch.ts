import { type Static, Type } from '@sinclair/typebox';
import type { Capability, SchedulerIntent } from '../capability.js';

/**
 * How long (scheduler-clock ms) a `set_switch_position` may go unconfirmed
 * before it is sent again. A lost or ignored command would otherwise leave a
 * train waiting at the junction forever, because the actuation is sent only
 * once per requested position. Point motors confirm well inside this.
 */
export const SWITCH_ACTUATION_TIMEOUT_MS = 3_000;

const ControlsSwitchState = Type.Object({
  /**
   * Per junction this device actuates: the position most recently requested or
   * confirmed, and while a request is unconfirmed, when it was sent. Holding
   * the last confirmed position as `requested` makes a request for the points'
   * current position a no-op, and a confirmation of some other position frees
   * the next request to move them back.
   */
  junctions: Type.Record(
    Type.String(),
    Type.Object({
      requested: Type.String(),
      requested_at: Type.Optional(Type.Number()),
    }),
  ),
});

type State = Static<typeof ControlsSwitchState>;
type JunctionRequest = State['junctions'][string];

/** The `device_registered` fields a switch declares (protocol 0.12.0 and 0.13.0, ADR-035). */
interface SwitchRegistration {
  readonly controls_marker_id?: string;
  readonly valid_positions?: string[];
}

interface SwitchStateChanged {
  readonly junction_marker_id: string;
  readonly position: string;
  readonly confirmed: boolean;
}

const withJunction = (state: State, junction: string, entry: JunctionRequest): State => ({
  junctions: { ...state.junctions, [junction]: entry },
});

const isOverdue = (entry: JunctionRequest | undefined, nowMs: number): boolean =>
  entry?.requested_at !== undefined && nowMs - entry.requested_at >= SWITCH_ACTUATION_TIMEOUT_MS;

const bindFromRegistration = (payload: unknown): SchedulerIntent[] => {
  // Shape guaranteed by the protocol schema at the broker boundary.
  const { controls_marker_id, valid_positions } = (payload ?? {}) as SwitchRegistration;
  if (controls_marker_id === undefined) return [];
  return [
    {
      kind: 'bind_junction',
      junction_marker_id: controls_marker_id,
      /* ADR-035: a switch declaring its positions IS the discovery-mode
         evidence that its marker is a junction with those legs. */
      valid_positions:
        valid_positions !== undefined && valid_positions.length > 0 ? valid_positions : undefined,
    },
  ];
};

/**
 * A device that moves the points at one junction. It binds the junction named
 * by `controls_marker_id` when it registers, sends `set_switch_position` when
 * the scheduler needs the points moved (once per position, again only after
 * `SWITCH_ACTUATION_TIMEOUT_MS` without confirmation), and reports each
 * `switch_state_changed` so a confirmed position becomes the layout's.
 */
export const controlsSwitchCapability: Capability<State> = {
  id: 'core.controls_switch',
  description: 'A device that controls a junction switch position.',

  customEvents: [], // uses the core switch_state_changed event
  customCommands: [], // uses the core set_switch_position command

  stateSchema: ControlsSwitchState,

  initialState: () => ({ junctions: {} }),

  hooks: {
    onEvent: (state, ctx) => {
      if (ctx.event_type === 'device_registered') {
        return { newState: state, intents: bindFromRegistration(ctx.payload) };
      }
      if (ctx.event_type !== 'switch_state_changed') return { newState: state, intents: [] };

      // Shape guaranteed by the protocol schema at the broker boundary.
      const { junction_marker_id, position, confirmed } = ctx.payload as SwitchStateChanged;
      return {
        newState: confirmed
          ? withJunction(state, junction_marker_id, { requested: position })
          : state,
        intents: [{ kind: 'report_switch_position', junction_marker_id, position, confirmed }],
      };
    },

    onActuationRequest: (state, request) => {
      const { device_id, junction_marker_id, position, now_ms } = request;
      const entry = state.junctions[junction_marker_id];
      const alreadyRequested = entry?.requested === position;
      if (alreadyRequested && !isOverdue(entry, now_ms)) return { newState: state, intents: [] };

      const command: SchedulerIntent = {
        kind: 'send_command',
        device_id,
        command_type: 'set_switch_position',
        payload: { junction_marker_id, position },
      };
      return {
        newState: withJunction(state, junction_marker_id, {
          requested: position,
          requested_at: now_ms,
        }),
        intents: alreadyRequested
          ? [
              {
                kind: 'emit_anomaly',
                severity: 'info',
                description: `Switch ${device_id} did not confirm ${junction_marker_id} -> ${position} within ${SWITCH_ACTUATION_TIMEOUT_MS}ms; sending again`,
              },
              command,
            ]
          : [command],
      };
    },

    isActuationOverdue: (state, { now_ms }) =>
      Object.values(state.junctions).some((entry) => isOverdue(entry, now_ms)),
  },
};
