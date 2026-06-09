/**
 * Protocol version. Bumped per semver:
 *   - patch: bug fixes, clarifications, no schema changes
 *   - minor: new optional fields, new event/command types (backward-compatible)
 *   - major: breaking changes (renamed/removed fields, type changes)
 *
 * Devices declare which version they speak. The server may run a compatibility
 * shim or refuse to talk to incompatible versions.
 *
 * 0.3.0 — added the `begin_exploration` command (ADR-015): open-ended discovery
 * clearance. Backward-compatible addition.
 * 0.4.0 — devices retained state documents { capabilities, train_length_mm? }
 * (ADR-016); multi-edge tail-release in the scheduler (ADR-012 refinement).
 * Backward-compatible addition.
 * 0.5.0 — optional `priority` on `device_registered` (ADR-017): the announced
 * term of the scheduler's total order over trains for section contention.
 * Backward-compatible addition; absent priority reproduces the FIFO floor.
 * 0.6.0 — new `topology_violation` event + optional `block_reason` field on the
 * retained clearance state (ADR-019): the scheduler-owned producer of the
 * pre-existing `'unknown_topology'` reason, surfaced when a bounded-route train
 * reports an unreachable marker. Backward-compatible additions; consumers that
 * don't understand either ignore it.
 * 0.7.0 — new `grant_reverse` command (ADR-022): a bounded, signed (backward)
 * clearance the scheduler issues to break an otherwise-unresolvable closed
 * nose-to-nose standoff by backing one train out of an occupied block into
 * track it provably holds. TCF registry epoch bumped 1 → 2 (command appended).
 * Backward-compatible addition; devices that don't understand it ignore it and
 * simply never reverse (default-stopped/safe).
 * 0.8.0 — new `core.gates_zone` capability + `zone_state_changed` event +
 * `ZoneRetainedState` (ADR-026): a device may own a capacity-limited territory
 * (a railyard) and gate admission to it by its own asserted occupancy, which
 * core cannot compute (carriages are invisible to it, ADR-016) and so trusts
 * like a length (ADR-023) or a tag binding (ADR-007). TCF registry epoch bumped
 * 2 → 3 (event appended). Backward-compatible additions; consumers that don't
 * understand the event or capability ignore them.
 * 0.9.0 — new `core.reports_length` capability + `train_length_changed` event
 * (ADR-023): a device may assert a train's physical length at runtime — the
 * producer need not be the train. The scheduler honours it only from a
 * `core.reports_length` device (mirroring `core.assigns_tags`), updates
 * `length_mm`, and re-derives tail-clearance occupancy on the next
 * `train_status`. TCF registry epoch bumped 3 → 4 (event appended).
 * Backward-compatible additions.
 * 0.10.0 — new `core.can_reverse` capability + `zone_train_released` event
 * (ADR-027): the zone interior handoff. A train is admitted to a zone only if it
 * declared `core.can_reverse` (interior shunting needs reversing); the device
 * releases a held train back to core authority with `zone_train_released`, and
 * the train departs only under ordinary clearance. TCF registry epoch bumped
 * 4 → 5 (event appended). Backward-compatible additions.
 */
export const PROTOCOL_VERSION = '0.10.0' as const;
