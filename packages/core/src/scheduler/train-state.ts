import type { EdgeRef } from './types.js';

/**
 * Per-train state held by the scheduler. The train itself also holds state
 * (it is, after all, an autonomous agent), but the scheduler maintains its
 * own view for routing decisions and clearance arbitration.
 *
 * The two views are reconciled via train_status events.
 */
export interface TrainState {
  readonly train_id: string;

  /**
   * Operator-facing intent: an ordered list of stops the train cycles
   * through indefinitely. See ADR-010. `undefined` for trains that have
   * been registered but never given a schedule.
   */
  schedule?:
    | {
        route_id: string;
        stops: ReadonlyArray<string>;
        /**
         * Index into `stops` of the marker the train is currently *heading to*.
         * On arrival at that stop the index advances (mod `stops.length`) and
         * the planner is re-invoked.
         */
        current_stop_index: number;
      }
    | undefined;

  /**
   * The transit currently being executed: the ordered list of edges from
   * the train's last position to `schedule.stops[current_stop_index]`,
   * computed by the planner. Replaced when the train arrives at the target
   * stop. `undefined` when the train has no schedule, or is parked at a
   * terminus stop on a single-stop schedule.
   */
  transit?:
    | {
        edges: ReadonlyArray<EdgeRef>;
        /** Index into `edges` of the edge the train is currently on or about to enter. */
        progress_index: number;
      }
    | undefined;

  /** The marker the train must not pass without further clearance. */
  clearance_limit_marker_id?: string;

  /** Edges the train is currently cleared for, in order. */
  cleared_edges: ReadonlyArray<EdgeRef>;

  /** Last marker the train was observed to traverse. */
  last_marker_id?: string;

  /** The edge the train is currently on, derived from last marker + transit. */
  current_edge?: EdgeRef | undefined;
}

export const initialTrainState = (trainId: string): TrainState => ({
  train_id: trainId,
  cleared_edges: [],
});
