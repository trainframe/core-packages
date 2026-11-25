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

  /**
   * Why the scheduler is holding this train, when it is held for a reason it
   * owns (ADR-019). `'unknown_topology'` means the train reported a marker
   * unreachable from its last certain position while running a bounded route:
   * its position is uncertain, so it is held and the uncertain region is kept
   * in `cleared_edges` to deny neighbours under block exclusivity. Surfaced on
   * the retained clearance state via `clearanceStateEffect`; cleared on any
   * normal re-grant or on operator recovery. `undefined` when not held for a
   * scheduler-owned reason.
   */
  block_reason?: 'unknown_topology' | undefined;

  /**
   * `true` after an operator `revokeClearance`: the scheduler grants this train
   * nothing until the operator gives it fresh intent (a new schedule). Without
   * it the next unrelated event's retry pass would re-grant the very blocks the
   * operator just took away. Internal only, never published.
   */
  operator_hold?: boolean | undefined;

  /** Last marker the train was observed to traverse. */
  last_marker_id?: string | undefined;

  /** The edge the train is currently on, derived from last marker + transit. */
  current_edge?: EdgeRef | undefined;

  /**
   * The edge the train arrived on when it suspended inside a zone (its
   * `current_edge` at the throat). `current_edge` is cleared on zone entry — the
   * train holds no block — so this preserves its HEADING, letting the planner
   * resume it FORWARD out the far side rather than reversing back the way it
   * came in. Cleared once the train moves on (crosses its next marker).
   */
  zone_entry_edge?: EdgeRef | undefined;

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

  /**
   * The zone boundary marker this train is suspended inside (ADR-027). Set when
   * an admitted train reaches a zone boundary as its route terminus: the train
   * passes into the device's opaque interior, holds no core blocks, and core
   * routes it no further until the owning device emits `zone_train_released`.
   * `undefined` when the train is under normal core authority.
   */
  in_zone?: string | undefined;

  /**
   * Set while the train backs up under a `grant_reverse` (ADR-022): the marker
   * it is reversing to and the markers of the blocks it is backing over. Its
   * crossings of those markers are reverse crossings, not forward traversals.
   * Cleared when it reaches the target or crosses any other marker.
   */
  reversing?:
    | {
        readonly target_marker_id: string;
        readonly path_marker_ids: ReadonlyArray<string>;
      }
    | undefined;

  /* ---- ADR-036 introduction lifecycle ---- */

  /**
   * `true` once this train's position and heading vector have resolved — it is
   * on the track and routable. `undefined`/`false` for a registered-but-not-yet-
   * introduced train: it is never granted clearance and never planned.
   */
  introduced?: boolean | undefined;

  /**
   * `true` while the two-marker introduction roll is in progress — between the
   * `introduceTrain()` call and the second marker crossing that resolves the
   * heading. Cleared on resolution. `undefined` when not in an introduction roll.
   */
  introducing?: boolean | undefined;

  /**
   * The first marker the train crossed DURING an introduction roll. Used to form
   * the heading edge when the second marker is crossed. Cleared on resolution.
   * `undefined` when not mid-roll or on the first crossing.
   */
  introduction_first_marker_id?: string | undefined;
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
