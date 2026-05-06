import { Type } from '@sinclair/typebox';

/**
 * Built-in capability identifiers. Satellite packages may define additional
 * capabilities; those are not enumerated here but follow the same `dotted.name`
 * convention to avoid collisions.
 *
 * Built-ins use the `core.` prefix. Satellites use `vendor.` prefixes:
 *   core.gates_clearance
 *   com.alice.controls_turntable
 */
export const BUILTIN_CAPABILITIES = [
  'core.identifies_vehicles',
  'core.reports_marker_traversal',
  'core.controls_motion',
  'core.accepts_route',
  'core.controls_switch',
  'core.displays_aspect',
  'core.gates_clearance',
  'core.assigns_tags',
] as const;

export type BuiltinCapability = (typeof BUILTIN_CAPABILITIES)[number];

/**
 * Schema for any capability identifier — built-in or third-party.
 * Pattern allows dotted lowercase names with hyphens, no whitespace.
 */
export const CapabilityId = Type.String({
  pattern: '^[a-z][a-z0-9.-]*[a-z0-9]$',
  minLength: 3,
});
