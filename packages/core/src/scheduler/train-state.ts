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

  /** The route currently assigned, if any. */
  route?: {
    route_id: string;
    edges: ReadonlyArray<EdgeRef>;
    /** Index into `edges` of the edge the train is currently on or about to enter. */
    progress_index: number;
  };

  /** The marker the train must not pass without further clearance. */
  clearance_limit_marker_id?: string;

  /** Edges the train is currently cleared for, in order. */
  cleared_edges: ReadonlyArray<EdgeRef>;

  /** Last marker the train was observed to traverse. */
  last_marker_id?: string;

  /** The edge the train is currently on, derived from last marker + route. */
  current_edge?: EdgeRef | undefined;
}

export const initialTrainState = (trainId: string): TrainState => ({
  train_id: trainId,
  cleared_edges: [],
});
