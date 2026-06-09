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
 */
export const PROTOCOL_VERSION = '0.7.0' as const;
