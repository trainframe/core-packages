/**
 * Protocol version. Bumped per semver:
 *   - patch: bug fixes, clarifications, no schema changes
 *   - minor: new optional fields, new event types (backward-compatible)
 *   - major: breaking changes (renamed/removed fields, type changes)
 *
 * Devices declare which version they speak. The server may run a compatibility
 * shim or refuse to talk to incompatible versions.
 */
export const PROTOCOL_VERSION = '0.2.0' as const;
