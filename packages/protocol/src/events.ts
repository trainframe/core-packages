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
  /**
   * Announced scheduling priority for section contention (ADR-017). Higher
   * wins when two trains contend for the same free section. OPTIONAL and
   * additive: when omitted every train is equal-priority and the scheduler's
   * FIFO-by-registration floor (then `train_id`) decides — the baseline is
   * fully deterministic without this field. Only meaningful for devices
   * declaring `core.controls_motion`.
   */
  priority: Type.Optional(Type.Number()),
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

// ---------- topology_violation (server-derived) ----------

/**
 * Server-derived (ADR-019). Emitted by the scheduler when a train running a
 * bounded route + clearance reports a marker that is unreachable from its last
 * known position — an adjacency the logical graph does not contain. Under a
 * bounded route the scheduler does NOT auto-learn the phantom edge (that is
 * always-on discovery's job, and only while the train is *open* to it —
 * exploring per ADR-015 or under track-learn per ADR-014). Instead it declares
 * the train's position uncertain, holds it, and flags it here.
 *
 * Non-retained: a one-shot operator/visualiser notification. The durable
 * "this train is held, and why" signal rides the retained clearance state's
 * `block_reason: 'unknown_topology'` field (the scheduler-owned producer); the
 * train MAY independently echo the matching `train_status.clearance_block_reason`.
 *
 * `suspected_cause` is a HINT for the operator UI only. The three real causes
 * (sensor fault / genuine new edge / lifted-and-replaced train) cannot be told
 * apart from a single event, so the automatic action never branches on it; the
 * scheduler defaults it to `'unknown'` with at most a coarse refinement when
 * `M` is a known-but-non-adjacent marker (more likely a missed read than a
 * brand-new edge).
 */
const TopologyViolationPayload = Type.Object({
  train_id: Uuid,
  /** P — the last position the scheduler is certain of. */
  last_known_marker_id: Uuid,
  /** M — the unreachable marker just reported. */
  reported_marker_id: Uuid,
  suspected_cause: Type.Union([
    Type.Literal('sensor_fault'),
    Type.Literal('unknown_edge'),
    Type.Literal('lifted_train'),
    Type.Literal('unknown'),
  ]),
  detected_at_ms: Type.Number(),
});

export const TopologyViolation = eventEnvelope('topology_violation', TopologyViolationPayload);
export type TopologyViolation = Static<typeof TopologyViolation>;

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

// ---------- zone_state_changed ----------

/**
 * Emitted by a `core.gates_zone` device (e.g. a railyard) whenever its
 * occupancy changes — a consist parks or leaves, or a siding is locked by a
 * cut of carriages with no locomotive. Carries the device's *own* judgment of
 * how full it is; core has no oracle for this (carriages are invisible to core,
 * ADR-016) and trusts the asserted count exactly as it trusts a length
 * (ADR-023) or a tag binding (ADR-007). See ADR-026.
 *
 * `zone_marker_id` — the boundary marker the zone presents to the core graph
 *   (the throat). Routing a train *into* the zone means clearing to this marker;
 *   the `core.gates_zone` capability denies that clearance while full.
 * `capacity` — total slots (parking positions) the zone owns.
 * `occupancy` — slots currently occupied, by the device's reckoning. Admission
 *   is denied while `occupancy >= capacity`.
 */
const ZoneStateChangedPayload = Type.Object({
  zone_marker_id: Uuid,
  capacity: Type.Integer({ minimum: 0 }),
  occupancy: Type.Integer({ minimum: 0 }),
});

export const ZoneStateChanged = eventEnvelope('zone_state_changed', ZoneStateChangedPayload);
export type ZoneStateChanged = Static<typeof ZoneStateChanged>;

// ---------- zone_train_released ----------

/**
 * Emitted by a `core.gates_zone` device to release a train it holds inside its
 * opaque interior, back to core's authority (ADR-027). The device asserts the
 * train has finished inside and is ready to leave; the scheduler reclaims it at
 * the throat and lets it depart only under ordinary clearance (main-line block
 * exclusivity holds — the device never drives a train across the throat itself).
 *
 * Honoured only from the device that owns `zone_marker_id`. Release and any
 * length change are independent: a train may leave unchanged, or the device may
 * also emit `train_length_changed` (ADR-023) for rearranged carriages.
 *
 * `zone_marker_id` — the zone boundary the train is held at.
 * `train_id` — the train to release.
 */
const ZoneTrainReleasedPayload = Type.Object({
  zone_marker_id: Uuid,
  train_id: Uuid,
});

export const ZoneTrainReleased = eventEnvelope('zone_train_released', ZoneTrainReleasedPayload);
export type ZoneTrainReleased = Static<typeof ZoneTrainReleased>;

// ---------- train_length_changed ----------

/**
 * Emitted by a `core.reports_length` device to assert a train's physical
 * length at runtime (ADR-023). The producer need NOT be the train itself — a
 * trackside station that attaches/detaches carriages, or a railyard, may report
 * a train's new length on its behalf. The scheduler honours it only from a
 * device that declared `core.reports_length` (mirroring `core.assigns_tags`),
 * updates the train's `length_mm`, and re-derives tail-clearance occupancy on
 * the train's next `train_status`.
 *
 * `train_id` — the train whose length changed (not necessarily `device_id`).
 * `train_length_mm` — the new nose-to-tail length; a finite, positive number.
 *   No value validation beyond structure: there is no oracle for a train's
 *   length, so the capability gate is the trust boundary (ADR-023 §1).
 */
const TrainLengthChangedPayload = Type.Object({
  train_id: Uuid,
  train_length_mm: Type.Number({ minimum: 0, exclusiveMinimum: 0 }),
});

export const TrainLengthChanged = eventEnvelope('train_length_changed', TrainLengthChangedPayload);
export type TrainLengthChanged = Static<typeof TrainLengthChanged>;

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
  TopologyViolation,
  VehicleIdentified,
  TrainStatus,
  ClearanceRequest,
  ClearanceGranted,
  ClearanceRevoked,
  GateStateChanged,
  SwitchStateChanged,
  ZoneStateChanged,
  ZoneTrainReleased,
  TrainLengthChanged,
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
  topology_violation: TopologyViolation,
  vehicle_identified: VehicleIdentified,
  train_status: TrainStatus,
  clearance_request: ClearanceRequest,
  clearance_granted: ClearanceGranted,
  clearance_revoked: ClearanceRevoked,
  gate_state_changed: GateStateChanged,
  switch_state_changed: SwitchStateChanged,
  zone_state_changed: ZoneStateChanged,
  zone_train_released: ZoneTrainReleased,
  train_length_changed: TrainLengthChanged,
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

// ---------- retained clearance state (railway/state/clearance/{train_id}) ----------

/**
 * Retained state the scheduler publishes to `railway/state/clearance/{train_id}`
 * on every clearance mutation (grant, release, revoke, disconnect). The
 * visualiser reads it to render which edges a train currently holds.
 *
 * `cleared_edges` — the edges the train is cleared for, in order. An empty
 *   array clears the train's overlay.
 * `block_reason` — present only when the scheduler is *holding* the train and
 *   why (ADR-019). `'unknown_topology'` means the train reported a marker
 *   unreachable from its last certain position under a bounded route: its
 *   position is uncertain, it is held, and the uncertain region is retained in
 *   `cleared_edges` so ADR-002 block exclusivity denies neighbours. This is the
 *   SCHEDULER-OWNED producer of the hold signal — distinct from the
 *   train-emitted `train_status.clearance_block_reason`, which a train MAY
 *   independently echo. Absent on a normally-cleared or freely-moving train.
 *
 * Added 0.6.0 (ADR-019): documents the previously-implicit retained payload
 * shape and adds the optional `block_reason` field.
 */
export const ClearanceRetainedState = Type.Object({
  train_id: Uuid,
  cleared_edges: Type.Array(EdgeRef),
  block_reason: Type.Optional(Type.Literal('unknown_topology')),
});
export type ClearanceRetainedState = Static<typeof ClearanceRetainedState>;

// ---------- retained zone state (railway/state/zones/{device_id}) ----------

/**
 * Retained state a `core.gates_zone` device publishes to
 * `railway/state/zones/{device_id}`, mirroring the most recent
 * `zone_state_changed`. Lets a fresh subscriber (the visualiser, a planner that
 * wants to avoid routing toward a full yard) read the zone's current capacity
 * and occupancy without replaying history.
 *
 * The values are the device's asserted reckoning — core neither computes nor
 * validates them beyond structure (ADR-026, the no-oracle trust boundary).
 *
 * Added 0.8.0 (ADR-026).
 */
export const ZoneRetainedState = Type.Object({
  zone_marker_id: Uuid,
  capacity: Type.Integer({ minimum: 0 }),
  occupancy: Type.Integer({ minimum: 0 }),
});
export type ZoneRetainedState = Static<typeof ZoneRetainedState>;
