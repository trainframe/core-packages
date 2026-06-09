/**
 * The Trainframe Compact Frame (TCF) compact-ID registry — ADR-021 §3.
 *
 * Maps each core `event_type` / `command_type` string to a stable 1-byte
 * compact ID, behind an integer "registry epoch". Used only by the ESP-NOW
 * bridge codec to translate between TCF frames and the canonical JSON
 * envelope; nothing on the MQTT bus ever sees a compact ID.
 *
 * Rules (ADR-021 §3):
 *   - Append-only and stable. IDs are never reused or renumbered; a new type
 *     gets the next free ID. Reorder/insert is forbidden — append at the end.
 *   - The epoch increments whenever an ID is added. It is distinct from
 *     `PROTOCOL_VERSION`.
 *   - `device_registered` is pinned at the lowest event ID (0) so it stays
 *     stable across every epoch — it is the type carried on first contact.
 *   - Event IDs and command IDs are *separate* spaces; the frame's
 *     `flags.is_command` bit disambiguates which table a `type_id` indexes.
 *
 * A CI test (registry.test.ts) asserts these arrays stay in exact one-to-one
 * correspondence with `CORE_EVENT_SCHEMAS` / `CORE_COMMAND_SCHEMAS`, so the
 * compact IDs cannot silently drift from the JSON event/command set.
 */

/**
 * Current registry epoch. Bump by 1 every time an entry is appended to
 * `EVENT_TYPE_ORDER` or `COMMAND_TYPE_ORDER`. Carried in TCF byte 0 so a
 * bridge serving mixed-firmware devices can decode each frame against the
 * right table and detect a stale device on its first frame.
 */
export const TCF_REGISTRY_EPOCH = 1 as const;

/**
 * Event types in compact-ID order. Index === compact `type_id`. APPEND-ONLY:
 * never reorder, never remove. `device_registered` is fixed at index 0.
 */
export const EVENT_TYPE_ORDER = [
  'device_registered',
  'tag_observed',
  'marker_traversed',
  'vehicle_identified',
  'train_status',
  'clearance_request',
  'clearance_granted',
  'clearance_revoked',
  'gate_state_changed',
  'switch_state_changed',
  'aspect_changed',
  'tag_assignment',
  'anomaly',
] as const;

/**
 * Command types in compact-ID order. Index === compact `type_id`.
 * APPEND-ONLY: never reorder, never remove.
 */
export const COMMAND_TYPE_ORDER = [
  'assign_route',
  'grant_clearance',
  'revoke_clearance',
  'begin_exploration',
  'set_target_speed',
  'emergency_stop',
  'set_switch_position',
  'set_aspect',
  'hold_gate',
  'release_gate',
  'assign_tag',
] as const;

export type CompactEventType = (typeof EVENT_TYPE_ORDER)[number];
export type CompactCommandType = (typeof COMMAND_TYPE_ORDER)[number];

/** The maximum compact ID is one byte: 0..255. */
export const MAX_COMPACT_ID = 255;

/**
 * Compact ID assigned to `anomaly` — the default-safe target an unknown
 * inbound `type_id` is expanded to (ADR-021 §3, "device newer than server").
 */
export const ANOMALY_TYPE_ID = EVENT_TYPE_ORDER.indexOf('anomaly');

const EVENT_TYPE_TO_ID = new Map<string, number>(EVENT_TYPE_ORDER.map((type, id) => [type, id]));
const COMMAND_TYPE_TO_ID = new Map<string, number>(
  COMMAND_TYPE_ORDER.map((type, id) => [type, id]),
);

/** Compact ID for an event type, or `undefined` if it has no mapping. */
export function eventTypeToId(eventType: string): number | undefined {
  return EVENT_TYPE_TO_ID.get(eventType);
}

/** Compact ID for a command type, or `undefined` if it has no mapping. */
export function commandTypeToId(commandType: string): number | undefined {
  return COMMAND_TYPE_TO_ID.get(commandType);
}

/** Event type for a compact ID, or `undefined` if the ID is unknown. */
export function idToEventType(id: number): CompactEventType | undefined {
  return EVENT_TYPE_ORDER[id];
}

/** Command type for a compact ID, or `undefined` if the ID is unknown. */
export function idToCommandType(id: number): CompactCommandType | undefined {
  return COMMAND_TYPE_ORDER[id];
}
