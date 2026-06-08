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
 */
export const PROTOCOL_VERSION = '0.4.0' as const;
