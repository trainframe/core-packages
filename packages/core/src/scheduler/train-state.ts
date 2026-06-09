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
   * Monotonic registration-sequence number, assigned by the scheduler the
   * first time this train registers (ADR-017). The FIFO-by-arrival floor of
   * the total order over trains: absent any announced priority, the train that
   * has been in the system longest wins contended track. Deterministic by
   * construction — a counter, no clock, no RNG. Lower wins.
   */
  readonly registration_seq: number;

  /**
   * Announced scheduling priority (ADR-017). Higher wins section contention.
   * Resolved at registration to a concrete number (defaulting to 0 when the
   * device omits the optional `priority` field), so the comparator never has
   * to reason about `undefined` and the baseline — every train at 0 — is
   * exactly the FIFO floor.
   */
  readonly priority: number;

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

  /**
   * Physical length of the train in millimetres. When undefined or 0 the
   * scheduler uses point-train semantics (release on marker_traversed).
   * When > 0 the scheduler waits for `train_status` to report
   * `estimated_distance_from_edge_start_mm >= length_mm` before releasing
   * the block behind the head. Populated from `device_registered.train_length_mm`.
   */
  length_mm?: number | undefined;

  /**
   * Injected-clock timestamp in ms before which the train must remain held at
   * its current scheduled stop (the dwell). Set on arrival at a scheduled
   * stop; the schedule pointer is not advanced and no onward clearance is
   * granted until an event observes `now() >= dwell_until`. `undefined` when
   * the train is not dwelling.
   */
  dwell_until?: number | undefined;
}

export const initialTrainState = (
  trainId: string,
  registrationSeq: number,
  priority = 0,
): TrainState => ({
  train_id: trainId,
  registration_seq: registrationSeq,
  priority,
  cleared_edges: [],
});
