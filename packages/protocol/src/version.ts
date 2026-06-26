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
 * 0.11.0 — optional `owned_marker_ids` on `device_registered` (ADR-034): a
 * `core.gates_zone` device declares the interior markers it owns — the track
 * "under the frame". Core records ownership (it never computes the list — the
 * device derives it from its own footprint, ADR-031) and enforces that nothing
 * else controls a marker the frame owns. Backward-compatible addition; a device
 * that omits it owns nothing beyond its zone boundary, exactly as before.
 * 0.12.0 — garage device commissioning (spec 2026-06-23). Operator-authored
 * `name` + `livery` on `device_registered` AND the retained `DeviceRetainedState`
 * (so a late-joining display sees them); `controls_marker_id` promoted to a
 * first-class field on `device_registered` (was read via an out-of-schema cast,
 * leaving third-party switches unable to actuate); `marker_name` added to
 * `tag_assignment` + `assign_tag` (naming a marker at bind time); `assign_tag`'s
 * `marker_kind` tightened from a free string to the shared `MarkerKind` enum (it
 * could previously accept a kind that can't round-trip into the event). All
 * additive/tightening; names/kinds are presentation only — the scheduler still
 * reasons on capabilities + topology, never on these fields.
 *
 * 0.13.0 — device onboarding, ADR-035 (Phase 1). `valid_positions` added to
 * `device_registered`: a `core.controls_switch` device declares the switch
 * positions it can be set to, so the server can materialise a junction (and
 * LearnMode survey its legs) in DISCOVERY mode without a declared layout.
 * Additive optional field; bumps the protocol version but NOT the TCF registry
 * epoch (a new field, not a new event type — per ADR-021 §3).
 *
 * 0.14.0 — device onboarding, ADR-035 (Phase 2). Two new event TYPES:
 * `device_discovered` (the bridge relays an unpaired device's announce so the
 * garage can offer to scan it) and `device_association` (binds a discovered
 * `device_ref` to the marker `tag_id` the operator scanned). New event types, so
 * this bumps BOTH the protocol version AND the TCF registry epoch (5 → 6, per
 * ADR-021 §3). Both ride the generic JSON carrier (no pinned compact codec).
 *
 * 0.15.0 — train introduction and activation lifecycle, ADR-036. New command
 * `introduce_train` (the operator gesture that begins vector resolution for a
 * registered train); new event `train_introduced` (the resolved position and
 * heading, emitted by the core after a two-marker roll or by a
 * `core.provides_train_heading` zone before it releases the train); new event
 * `train_introduction_conflict` (an unresolvable overlap at the moment the
 * vector resolves — operator must intervene); new capability
 * `core.provides_train_heading` (a zone/device that supplies a train's heading
 * on emergence). New event/command types append so this bumps BOTH the
 * protocol version AND the TCF registry epoch (6 → 7, per ADR-021 §3).
 */
export const PROTOCOL_VERSION = '0.15.0' as const;
