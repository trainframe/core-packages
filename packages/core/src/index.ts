export type {
  Capability,
  CapabilityHooks,
  CapabilityHookResult,
  CapabilityEventContext,
  ClearanceConsultation,
  ClearanceVote,
  SchedulerIntent,
  RegisteredCapability,
} from './capability.js';
export { wrap as wrapCapability } from './capability.js';

export { CapabilityRegistry } from './registry.js';

export {
  BUILTIN_CAPABILITIES,
  gatesClearanceCapability,
  identifiesVehiclesCapability,
  reportsMarkerTraversalCapability,
  controlsMotionCapability,
  acceptsRouteCapability,
  controlsSwitchCapability,
  displaysAspectCapability,
  assignsTagsCapability,
} from './builtins/index.js';

export { Scheduler, LayoutState } from './scheduler/index.js';
export type { TrainState, SchedulerEffect, EdgeRef } from './scheduler/index.js';
