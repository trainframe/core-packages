import { type Static, Type } from '@sinclair/typebox';
import { CapabilityId } from './capabilities.js';
import { Direction, EdgeRef, Uuid, eventEnvelope } from './envelope.js';

// ---------- device_registered ----------

const DeviceRegisteredPayload = Type.Object({
  capabilities: Type.Array(CapabilityId),
  device_kind_hint: Type.String(),
  display_hint: Type.Optional(
    Type.Object({
      icon: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      colour: Type.Optional(Type.String()),
    }),
  ),
  custom_events: Type.Optional(
    Type.Array(
      Type.Object({
        event_type: Type.String(),
        description: Type.Optional(Type.String()),
      }),
    ),
  ),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /**
   * Physical length of the train in millimetres. When present and > 0, the
   * scheduler defers clearing the section behind the head until
   * `train_status.estimated_distance_from_edge_start_mm >= train_length_mm`,
   * ensuring the tail has fully vacated before releasing the block. Only
   * meaningful for devices declaring `core.controls_motion`.
   */
  train_length_mm: Type.Optional(Type.Number({ minimum: 0 })),
});

export const DeviceRegistered = eventEnvelope('device_registered', DeviceRegisteredPayload);
export type DeviceRegistered = Static<typeof DeviceRegistered>;

// ---------- tag_observed ----------

const TagObservedPayload = Type.Object({
  tag_id: Type.String({ minLength: 1 }),
  direction: Type.Optional(Direction),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export const TagObserved = eventEnvelope('tag_observed', TagObservedPayload);
export type TagObserved = Static<typeof TagObserved>;

// ---------- marker_traversed (server-derived) ----------

const MarkerTraversedPayload = Type.Object({
  train_id: Uuid,
  marker_id: Uuid,
  direction: Direction,
  inferred_edge: Type.Optional(EdgeRef),
  in_discovery_mode: Type.Boolean(),
});

export const MarkerTraversed = eventEnvelope('marker_traversed', MarkerTraversedPayload);
export type MarkerTraversed = Static<typeof MarkerTraversed>;

// ---------- vehicle_identified (server-derived) ----------

/**
 * Server-derived from a `tag_observed` whose tag resolves to a vehicle in
 * the `TagRegistry`. Names which vehicle was identified and which device
 * saw it (yard sensor, garage slot, on-train reader).
 */
const VehicleIdentifiedPayload = Type.Object({
  vehicle_id: Type.String(),
  context_device_id: Type.String(),
});

export const VehicleIdentified = eventEnvelope('vehicle_identified', VehicleIdentifiedPayload);
export type VehicleIdentified = Static<typeof VehicleIdentified>;

// ---------- train_status ----------

const TrainStatusPayload = Type.Object({
  train_id: Uuid,
  current_edge: Type.Optional(EdgeRef),
  estimated_distance_from_edge_start_mm: Type.Optional(Type.Number()),
  speed_normalised: Type.Number({ minimum: 0, maximum: 1 }),
  clearance_limit_marker_id: Type.Optional(Uuid),
  clearance_block_reason: Type.Optional(
    Type.Union([
      Type.Literal('block_occupied'),
      Type.Literal('device_gated'),
      Type.Literal('unknown_topology'),
      Type.Literal('manually_revoked'),
    ]),
  ),
  route_id: Type.Optional(Uuid),
  route_progress_edge_index: Type.Optional(Type.Integer({ minimum: 0 })),
  battery_normalised: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  error_state: Type.Optional(Type.String()),
});

export const TrainStatus = eventEnvelope('train_status', TrainStatusPayload);
export type TrainStatus = Static<typeof TrainStatus>;

// ---------- clearance_request ----------

const ClearanceRequestPayload = Type.Object({
  train_id: Uuid,
  current_limit_marker_id: Uuid,
  next_edge: EdgeRef,
});

export const ClearanceRequest = eventEnvelope('clearance_request', ClearanceRequestPayload);
export type ClearanceRequest = Static<typeof ClearanceRequest>;

// ---------- clearance_granted ----------

const ClearanceGrantedPayload = Type.Object({
  train_id: Uuid,
  new_limit_marker_id: Uuid,
  edges_newly_cleared: Type.Array(EdgeRef),
});

export const ClearanceGranted = eventEnvelope('clearance_granted', ClearanceGrantedPayload);
export type ClearanceGranted = Static<typeof ClearanceGranted>;

// ---------- clearance_revoked ----------

const ClearanceRevokedPayload = Type.Object({
  train_id: Uuid,
  reason: Type.String(),
  stop_at_marker_id: Type.Optional(Uuid),
  immediate: Type.Boolean(),
});

export const ClearanceRevoked = eventEnvelope('clearance_revoked', ClearanceRevokedPayload);
export type ClearanceRevoked = Static<typeof ClearanceRevoked>;

// ---------- gate_state_changed ----------

const GateStateChangedPayload = Type.Object({
  marker_id: Uuid,
  state: Type.Union([Type.Literal('granting'), Type.Literal('withholding')]),
  reason: Type.Optional(Type.String()),
});

export const GateStateChanged = eventEnvelope('gate_state_changed', GateStateChangedPayload);
export type GateStateChanged = Static<typeof GateStateChanged>;

// ---------- switch_state_changed ----------

const SwitchStateChangedPayload = Type.Object({
  junction_marker_id: Uuid,
  position: Type.String(),
  confirmed: Type.Boolean(),
});

export const SwitchStateChanged = eventEnvelope('switch_state_changed', SwitchStateChangedPayload);
export type SwitchStateChanged = Static<typeof SwitchStateChanged>;

// ---------- aspect_changed ----------

const AspectChangedPayload = Type.Object({
  current_aspect: Type.String(),
});

export const AspectChanged = eventEnvelope('aspect_changed', AspectChangedPayload);
export type AspectChanged = Static<typeof AspectChanged>;

// ---------- tag_assignment ----------

const TagAssignmentPayload = Type.Object({
  tag_id: Type.String(),
  assigned_kind: Type.Union([Type.Literal('vehicle'), Type.Literal('marker')]),
  /**
   * ID of the entity this tag refers to. Must match an existing marker
   * ID when `assigned_kind === 'marker'`, or a train ID when
   * `assigned_kind === 'vehicle'`.
   */
  target_id: Type.String(),
  marker_kind: Type.Optional(
    Type.Union([
      Type.Literal('block_boundary'),
      Type.Literal('station_stop'),
      Type.Literal('junction'),
      Type.Literal('terminus'),
      Type.Literal('yard_entry'),
      Type.Literal('unspecified'),
    ]),
  ),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const TagAssignment = eventEnvelope('tag_assignment', TagAssignmentPayload);
export type TagAssignment = Static<typeof TagAssignment>;

// ---------- anomaly ----------

const AnomalyPayload = Type.Object({
  severity: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error')]),
  description: Type.String(),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export const Anomaly = eventEnvelope('anomaly', AnomalyPayload);
export type Anomaly = Static<typeof Anomaly>;

// ---------- Discriminated union ----------

export const CoreEvent = Type.Union([
  DeviceRegistered,
  TagObserved,
  MarkerTraversed,
  VehicleIdentified,
  TrainStatus,
  ClearanceRequest,
  ClearanceGranted,
  ClearanceRevoked,
  GateStateChanged,
  SwitchStateChanged,
  AspectChanged,
  TagAssignment,
  Anomaly,
]);
export type CoreEvent = Static<typeof CoreEvent>;

/**
 * Map of event_type literals to their schemas. Used by the server's
 * validation layer to pick the right schema given an incoming message.
 */
export const CORE_EVENT_SCHEMAS = {
  device_registered: DeviceRegistered,
  tag_observed: TagObserved,
  marker_traversed: MarkerTraversed,
  vehicle_identified: VehicleIdentified,
  train_status: TrainStatus,
  clearance_request: ClearanceRequest,
  clearance_granted: ClearanceGranted,
  clearance_revoked: ClearanceRevoked,
  gate_state_changed: GateStateChanged,
  switch_state_changed: SwitchStateChanged,
  aspect_changed: AspectChanged,
  tag_assignment: TagAssignment,
  anomaly: Anomaly,
} as const;

// ---------- retained device state (railway/state/devices/{device_id}) ----------

/**
 * Retained state the server publishes to `railway/state/devices/{device_id}`
 * when a device registers. Subscribers (the visualiser, satellite services)
 * receive the current state of every connected device on first subscribe
 * without replaying history.
 *
 * `capabilities` — the capability IDs the device declared at registration.
 * `train_length_mm` — physical length of a train in mm, present only when the
 *   device declared `core.controls_motion` and supplied a positive length.
 *   Used by the visualiser to render the consist to scale (ADR-016).
 *
 * Added 0.4.0 (ADR-016): documents the previously-implicit retained payload
 * shape and adds the optional `train_length_mm` field.
 */
export const DeviceRetainedState = Type.Object({
  capabilities: Type.Array(CapabilityId),
  train_length_mm: Type.Optional(Type.Number({ minimum: 0, exclusiveMinimum: 0 })),
});
export type DeviceRetainedState = Static<typeof DeviceRetainedState>;
