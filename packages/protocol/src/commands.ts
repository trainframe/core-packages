import { type Static, Type } from '@sinclair/typebox';
import { EdgeRef, Uuid, commandEnvelope } from './envelope.js';

// ---------- assign_route ----------

const AssignRoutePayload = Type.Object({
  route_id: Uuid,
  edges: Type.Array(EdgeRef, { minItems: 1 }),
  dwell_instructions: Type.Optional(
    Type.Array(
      Type.Object({
        at_edge_index: Type.Integer({ minimum: 0 }),
        position: Type.Union([Type.Literal('start'), Type.Literal('end')]),
        duration_ms: Type.Integer({ minimum: 0 }),
      }),
    ),
  ),
});

export const AssignRoute = commandEnvelope('assign_route', AssignRoutePayload);
export type AssignRoute = Static<typeof AssignRoute>;

// ---------- grant_clearance ----------

const GrantClearancePayload = Type.Object({
  limit_marker_id: Uuid,
  reason: Type.Optional(Type.String()),
});

export const GrantClearance = commandEnvelope('grant_clearance', GrantClearancePayload);
export type GrantClearance = Static<typeof GrantClearance>;

// ---------- revoke_clearance ----------

const RevokeClearancePayload = Type.Object({
  reason: Type.String(),
  immediate: Type.Boolean(),
});

export const RevokeClearance = commandEnvelope('revoke_clearance', RevokeClearancePayload);
export type RevokeClearance = Static<typeof RevokeClearance>;

// ---------- set_target_speed ----------

const SetTargetSpeedPayload = Type.Object({
  speed_normalised: Type.Number({ minimum: 0, maximum: 1 }),
});

export const SetTargetSpeed = commandEnvelope('set_target_speed', SetTargetSpeedPayload);
export type SetTargetSpeed = Static<typeof SetTargetSpeed>;

// ---------- emergency_stop ----------

export const EmergencyStop = commandEnvelope('emergency_stop', Type.Object({}));
export type EmergencyStop = Static<typeof EmergencyStop>;

// ---------- set_switch_position ----------

const SetSwitchPositionPayload = Type.Object({
  junction_marker_id: Uuid,
  position: Type.String(),
});

export const SetSwitchPosition = commandEnvelope('set_switch_position', SetSwitchPositionPayload);
export type SetSwitchPosition = Static<typeof SetSwitchPosition>;

// ---------- set_aspect ----------

const SetAspectPayload = Type.Object({
  aspect: Type.String(),
});

export const SetAspect = commandEnvelope('set_aspect', SetAspectPayload);
export type SetAspect = Static<typeof SetAspect>;

// ---------- hold_gate / release_gate ----------

/**
 * Server-side override of a `gates_clearance` device's local logic. The
 * gate honours the override and publishes a matching `gate_state_changed`
 * event. Rare in normal operation: stations decide their own dwell. Used
 * by the operator/visualiser to force a hold (e.g. during a fault) or to
 * release a train that's been left stranded.
 */
const HoldGatePayload = Type.Object({
  marker_id: Uuid,
  reason: Type.Optional(Type.String()),
});

export const HoldGate = commandEnvelope('hold_gate', HoldGatePayload);
export type HoldGate = Static<typeof HoldGate>;

const ReleaseGatePayload = Type.Object({
  marker_id: Uuid,
});

export const ReleaseGate = commandEnvelope('release_gate', ReleaseGatePayload);
export type ReleaseGate = Static<typeof ReleaseGate>;

// ---------- assign_tag ----------

const AssignTagPayload = Type.Object({
  tag_id: Type.String(),
  assigned_kind: Type.Union([Type.Literal('vehicle'), Type.Literal('marker')]),
  /** ID of the entity this tag will refer to (marker_id or train_id). */
  target_id: Type.String(),
  marker_kind: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const AssignTag = commandEnvelope('assign_tag', AssignTagPayload);
export type AssignTag = Static<typeof AssignTag>;

// ---------- Discriminated union ----------

export const CoreCommand = Type.Union([
  AssignRoute,
  GrantClearance,
  RevokeClearance,
  SetTargetSpeed,
  EmergencyStop,
  SetSwitchPosition,
  SetAspect,
  HoldGate,
  ReleaseGate,
  AssignTag,
]);
export type CoreCommand = Static<typeof CoreCommand>;

export const CORE_COMMAND_SCHEMAS = {
  assign_route: AssignRoute,
  grant_clearance: GrantClearance,
  revoke_clearance: RevokeClearance,
  set_target_speed: SetTargetSpeed,
  emergency_stop: EmergencyStop,
  set_switch_position: SetSwitchPosition,
  set_aspect: SetAspect,
  hold_gate: HoldGate,
  release_gate: ReleaseGate,
  assign_tag: AssignTag,
} as const;
