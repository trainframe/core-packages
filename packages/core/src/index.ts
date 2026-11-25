export type {
  ActuationClock,
  ActuationRequest,
  Capability,
  CapabilityHooks,
  CapabilityHookResult,
  CapabilityEventContext,
  ClearanceConsultation,
  ClearanceVote,
  LayoutIntent,
  SchedulerIntent,
  RegisteredCapability,
} from './capability.js';
export { wrap as wrapCapability } from './capability.js';

export { CapabilityRegistry } from './registry.js';

export {
  BUILTIN_CAPABILITIES,
  declarationCapability,
  gatesClearanceCapability,
  identifiesVehiclesCapability,
  reportsMarkerTraversalCapability,
  controlsMotionCapability,
  acceptsRouteCapability,
  controlsSwitchCapability,
  SWITCH_ACTUATION_TIMEOUT_MS,
  displaysAspectCapability,
  assignsTagsCapability,
} from './builtins/index.js';

export { Scheduler, LayoutState, planTransit } from './scheduler/index.js';
export type { TrainState, SchedulerEffect, EdgeRef } from './scheduler/index.js';
