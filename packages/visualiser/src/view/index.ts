/**
 * Framework-independent view layer for the Trainframe visualiser.
 *
 * Each class in this directory:
 *   - Takes a `BrokerSubscriber` in its constructor.
 *   - Owns topic subscriptions and state-derivation logic.
 *   - Exposes `getState()` (stable reference when unchanged) and
 *     `subscribe(listener)` (ref-counted broker subscription).
 *   - Contains zero React imports — usable from any framework or runtime.
 *
 * The corresponding React hooks in `src/state/` are thin wrappers that
 * bridge these classes into React's render cycle via `useSyncExternalStore`.
 *
 * An e-paper or alternative-framework consumer imports from here and calls
 * `view.subscribe(renderCallback)` / `view.getState()` directly.
 *
 * ## Extraction status
 *
 * Extracted:
 *   - RegisteredDevicesView  (src/view/registered-devices-view.ts)
 *
 * TODO: extract the following hooks to this layer when needed:
 *   - use-layout-state          → LayoutStateView
 *   - use-registered-trains     → RegisteredTrainsView (derives from RegisteredDevicesView)
 *   - use-train-positions       → TrainPositionsView
 *   - use-train-statuses        → TrainStatusesView
 *   - use-schedule-state        → ScheduleStateView
 *   - use-unknown-tags          → UnknownTagsView
 *   - use-deadlock-state        → DeadlockStateView
 *   - use-track-learning-state  → TrackLearningStateView
 *   - use-last-scanned          → LastScannedView
 *   - use-clearance-state       → ClearanceStateView
 *   - use-event-log             → EventLogView
 */

export type { RegisteredDevice, RegisteredDevices } from './registered-devices-view.js';
export { RegisteredDevicesView } from './registered-devices-view.js';
