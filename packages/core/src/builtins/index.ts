/**
 * Built-in capabilities. Each is implemented through the same Capability<State>
 * interface that satellites use — there is no privileged path. A platform
 * calls `registry.registerAll(BUILTIN_CAPABILITIES)` to install the standard
 * set, or registers individual built-ins selectively for custom platforms.
 */

import { Type } from '@sinclair/typebox';
import type { Capability } from '../capability.js';
import { gatesClearanceCapability } from './gates-clearance.js';
import { gatesZoneCapability } from './gates-zone.js';

const stubCapability = (id: string, description: string): Capability<Record<string, never>> => ({
  id,
  description,
  customEvents: [],
  customCommands: [],
  stateSchema: Type.Object({}),
  initialState: () => ({}),
  hooks: {},
});

export const identifiesVehiclesCapability = stubCapability(
  'core.identifies_vehicles',
  'A device that reads vehicle tags and emits vehicle_identified events.',
);

export const reportsMarkerTraversalCapability = stubCapability(
  'core.reports_marker_traversal',
  'A device that detects vehicles passing markers and emits tag_observed events.',
);

export const controlsMotionCapability = stubCapability(
  'core.controls_motion',
  'A device (typically a train) that accepts motion commands.',
);

export const acceptsRouteCapability = stubCapability(
  'core.accepts_route',
  'A device that accepts route assignments and executes them.',
);

export const controlsSwitchCapability = stubCapability(
  'core.controls_switch',
  'A device that controls a junction switch position.',
);

export const displaysAspectCapability = stubCapability(
  'core.displays_aspect',
  'A device that displays a current aspect (signal, departure board, etc.).',
);

export const assignsTagsCapability = stubCapability(
  'core.assigns_tags',
  'A device that assigns meaning to previously-unknown tags.',
);

export const reportsLengthCapability = stubCapability(
  'core.reports_length',
  "A device that asserts a train's physical length at runtime (ADR-023). The " +
    'scheduler enforces that only devices declaring it may emit train_length_changed.',
);

export { gatesClearanceCapability };
export { gatesZoneCapability };

/**
 * The full set of built-in capabilities. The element type is
 * `Capability<unknown>` because the array is heterogeneous; each element
 * preserves its real State type when individually registered.
 */
export const BUILTIN_CAPABILITIES: ReadonlyArray<Capability<unknown>> = [
  identifiesVehiclesCapability,
  reportsMarkerTraversalCapability,
  controlsMotionCapability,
  acceptsRouteCapability,
  controlsSwitchCapability,
  displaysAspectCapability,
  gatesClearanceCapability,
  assignsTagsCapability,
  gatesZoneCapability,
  reportsLengthCapability,
] as ReadonlyArray<Capability<unknown>>;
