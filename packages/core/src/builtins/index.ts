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

/**
 * A capability with no hooks whose only effect is that the scheduler checks for
 * it. `enforced` names the behaviour the scheduler restricts, and the contract
 * "the scheduler enforces <enforced> only for devices that declare this" is
 * appended to the description so every declaration states it the same way.
 */
export const declarationCapability = (
  id: string,
  description: string,
  enforced: string,
): Capability<Record<string, never>> =>
  stubCapability(
    id,
    `${description} The scheduler enforces ${enforced} only for devices that declare this.`,
  );

export const identifiesVehiclesCapability = declarationCapability(
  'core.identifies_vehicles',
  'A trackside device that reads vehicle tags.',
  'vehicle_identified derivation from tag_observed',
);

export const reportsMarkerTraversalCapability = declarationCapability(
  'core.reports_marker_traversal',
  'A device that reads marker tags and emits tag_observed events.',
  'marker crossings from tag_observed',
);

export const controlsMotionCapability = declarationCapability(
  'core.controls_motion',
  'Marks a device as a train: the scheduler keeps train state, a schedule and clearance for it.',
  'train state, scheduling and clearance',
);

export const acceptsRouteCapability = declarationCapability(
  'core.accepts_route',
  'A train that executes assigned routes.',
  'route assignment (assign_route is sent and a transit started)',
);

export const controlsSwitchCapability = stubCapability(
  'core.controls_switch',
  'A device that controls a junction switch position.',
);

export const displaysAspectCapability = stubCapability(
  'core.displays_aspect',
  'A device that displays a current aspect (signal, departure board, etc.).',
);

export const assignsTagsCapability = declarationCapability(
  'core.assigns_tags',
  'A device that assigns meaning to previously-unknown tags.',
  'tag_assignment',
);

export const reportsLengthCapability = declarationCapability(
  'core.reports_length',
  "A device that asserts a train's physical length at runtime (ADR-023).",
  'train_length_changed',
);

export const canReverseCapability = declarationCapability(
  'core.can_reverse',
  'A train whose hardware can run backward (ADR-027). Required for admission to a zone, whose interior is worked by shunting.',
  'zone admission',
);

export const providesTrainHeadingCapability = declarationCapability(
  'core.provides_train_heading',
  "A zone or device that supplies a train's heading on emergence (ADR-036 §3b) by emitting train_introduced before releasing the train.",
  'train_introduced',
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
  canReverseCapability,
  providesTrainHeadingCapability,
] as ReadonlyArray<Capability<unknown>>;
