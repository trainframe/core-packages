import type { TSchema } from '@sinclair/typebox';

/**
 * A Capability defines what a class of devices can do, declaratively.
 *
 * This is the central extensibility primitive of Trainframe. Built-in
 * capabilities are defined the same way third-party capabilities are; there
 * is no privileged path for built-ins.
 *
 * Capabilities are generic over their `State` type — different capabilities
 * legitimately have different state shapes. The `Capability<State>` interface
 * is what authors *write*; the registry stores them under an existential
 * wrapper (`RegisteredCapability`) that hides the State variance. See
 * `wrap()` below for the wrapping mechanism.
 */
export interface Capability<State> {
  /** Identifier. Built-ins use `core.<name>`; satellites use `<vendor>.<name>`. */
  readonly id: string;

  /** Human-readable description. */
  readonly description: string;

  /** Custom event types this capability introduces, beyond core events. */
  readonly customEvents: ReadonlyArray<{
    event_type: string;
    payloadSchema: TSchema;
  }>;

  /** Custom command types this capability introduces. */
  readonly customCommands: ReadonlyArray<{
    command_type: string;
    payloadSchema: TSchema;
  }>;

  /** Per-device state schema. Use `Type.Object({})` if no state is needed. */
  readonly stateSchema: TSchema;

  /** Initial state for a newly-registered device declaring this capability. */
  readonly initialState: (deviceId: string) => State;

  /**
   * Hooks the platform invokes during scheduling. Pure functions:
   * (state, event) → (newState, intents). No I/O. No async.
   */
  readonly hooks: CapabilityHooks<State>;
}

export interface CapabilityHooks<State> {
  readonly onEvent?: (state: State, event: CapabilityEventContext) => CapabilityHookResult<State>;

  readonly onClearanceConsultation?: (
    state: State,
    request: ClearanceConsultation,
  ) => ClearanceVote;

  readonly onDeviceDisconnect?: (state: State) => CapabilityHookResult<State>;

  /**
   * The scheduler needs the junction this device is bound to (see the
   * `bind_junction` intent) set to `position` before a train may cross it. The
   * hook decides whether to command the hardware now: it is asked again on
   * every clearance retry while the train waits, so it should stay quiet while
   * an earlier request is still in flight.
   */
  readonly onActuationRequest?: (
    state: State,
    request: ActuationRequest,
  ) => CapabilityHookResult<State>;

  /**
   * True when a request this device accepted has gone unanswered long enough to
   * be sent again. Polled whenever a train reports its status; a true answer
   * makes the scheduler retry blocked clearances, which re-asks
   * `onActuationRequest`.
   */
  readonly isActuationOverdue?: (state: State, query: ActuationClock) => boolean;
}

/** The scheduler's injected clock, never the wall clock. */
export interface ActuationClock {
  readonly now_ms: number;
}

export interface ActuationRequest extends ActuationClock {
  /** The device the request is for: the one bound to the junction. */
  readonly device_id: string;
  readonly junction_marker_id: string;
  /** The `requires_switch_state` of the edge the waiting train needs next. */
  readonly position: string;
}

export interface CapabilityEventContext {
  readonly device_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly device_capabilities: ReadonlyArray<string>;
}

export interface CapabilityHookResult<State> {
  readonly newState: State;
  readonly intents: ReadonlyArray<SchedulerIntent>;
}

export type SchedulerIntent =
  | { kind: 'send_command'; device_id: string; command_type: string; payload: unknown }
  | { kind: 'withhold_clearance_at_marker'; marker_id: string; reason: string }
  | { kind: 'release_clearance_at_marker'; marker_id: string }
  | { kind: 'emit_anomaly'; severity: 'info' | 'warning' | 'error'; description: string }
  /**
   * Bind the emitting device to a junction, so the scheduler asks it (through
   * `onActuationRequest`) to move those points. `valid_positions` records the
   * marker as a junction with those legs. Refused with an anomaly when a
   * `core.gates_zone` frame already owns the marker.
   */
  | {
      kind: 'bind_junction';
      junction_marker_id: string;
      valid_positions?: ReadonlyArray<string> | undefined;
    }
  /**
   * The points at a junction are reported at `position`. Published as retained
   * switch state either way; a confirmed position becomes the layout's and
   * releases trains that were waiting for it.
   */
  | {
      kind: 'report_switch_position';
      junction_marker_id: string;
      position: string;
      confirmed: boolean;
    };

/** The intents the scheduler applies to the layout rather than passing to the platform. */
export type LayoutIntent = Extract<
  SchedulerIntent,
  { kind: 'bind_junction' | 'report_switch_position' }
>;

export interface ClearanceConsultation {
  readonly train_id: string;
  readonly current_limit_marker_id: string;
  readonly proposed_new_limit_marker_id: string;
  readonly proposed_edges_to_clear: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>;
}

export type ClearanceVote =
  | { vote: 'permit' }
  | { vote: 'deny'; reason: string }
  | { vote: 'abstain' };

// ---------- existential wrapper ----------

/**
 * The "outside" view of a capability — operations the registry can perform
 * without knowing the State type. This is the existential wrapper that lets
 * heterogeneous capabilities live in one collection without `any`.
 *
 * Each method accepts and returns `unknown` for state. Concrete State types
 * are enforced inside `wrap()`, where every state value flowing in came from
 * this same capability instance's `initialiseStateFor`.
 */
export interface RegisteredCapability {
  readonly id: string;
  readonly description: string;
  readonly customEvents: ReadonlyArray<{ event_type: string; payloadSchema: TSchema }>;
  readonly customCommands: ReadonlyArray<{ command_type: string; payloadSchema: TSchema }>;
  readonly stateSchema: TSchema;

  initialiseStateFor(deviceId: string): unknown;

  invokeOnEvent(
    state: unknown,
    ctx: CapabilityEventContext,
  ): { newState: unknown; intents: ReadonlyArray<SchedulerIntent> };

  invokeOnClearanceConsultation(
    state: unknown,
    request: ClearanceConsultation,
  ): ClearanceVote | undefined;

  invokeOnDeviceDisconnect(state: unknown): {
    newState: unknown;
    intents: ReadonlyArray<SchedulerIntent>;
  };

  invokeOnActuationRequest(
    state: unknown,
    request: ActuationRequest,
  ): { newState: unknown; intents: ReadonlyArray<SchedulerIntent> };

  invokeIsActuationOverdue(state: unknown, query: ActuationClock): boolean;
}

/**
 * Wrap a typed Capability<State> into a RegisteredCapability. This is the
 * *only* place in the codebase where state types are coerced — and the
 * coercion is sound, because every state value that flows back into these
 * methods came originally from this same capability's `initialiseStateFor`.
 *
 * Authors write `Capability<MyState>`. The registry stores the wrapped form.
 */
export function wrap<State>(cap: Capability<State>): RegisteredCapability {
  return {
    id: cap.id,
    description: cap.description,
    customEvents: cap.customEvents,
    customCommands: cap.customCommands,
    stateSchema: cap.stateSchema,

    initialiseStateFor(deviceId) {
      return cap.initialState(deviceId);
    },

    invokeOnEvent(state, ctx) {
      const hook = cap.hooks.onEvent;
      if (!hook) return { newState: state, intents: [] };
      const result = hook(state as State, ctx);
      return { newState: result.newState, intents: result.intents };
    },

    invokeOnClearanceConsultation(state, request) {
      const hook = cap.hooks.onClearanceConsultation;
      if (!hook) return undefined;
      return hook(state as State, request);
    },

    invokeOnDeviceDisconnect(state) {
      const hook = cap.hooks.onDeviceDisconnect;
      if (!hook) return { newState: state, intents: [] };
      const result = hook(state as State);
      return { newState: result.newState, intents: result.intents };
    },

    invokeOnActuationRequest(state, request) {
      const hook = cap.hooks.onActuationRequest;
      if (!hook) return { newState: state, intents: [] };
      const result = hook(state as State, request);
      return { newState: result.newState, intents: result.intents };
    },

    invokeIsActuationOverdue(state, query) {
      return cap.hooks.isActuationOverdue?.(state as State, query) ?? false;
    },
  };
}
