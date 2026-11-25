import type { SchedulerEffect } from './effects.js';
import type { TrainState } from './train-state.js';

/**
 * Single ownership of a piece of track (ADR-034). A marker under a
 * `core.gates_zone` frame cannot be actuated by a switch device, and a junction a
 * switch device controls cannot be claimed by a frame. Zones and switches each
 * record their own claims and consult the other's through this.
 */
export interface MarkerOwnership {
  /** The zone device that owns `markerId` as interior, if any. */
  zoneOwnerOf(markerId: string): string | undefined;
  /** The switch device paired to `markerId` as its junction, if any. */
  switchOwnerOf(markerId: string): string | undefined;
}

/** Where a train's resolved marker read goes once identity has authorised it. */
export interface MarkerCrossings {
  handleTrainCrossing(trainId: string, markerId: string): ReadonlyArray<SchedulerEffect>;
}

/**
 * Re-run the clearance horizon for every train, in the total order, after a
 * change that may have freed track. `skipTrainIds` keeps a train that was just
 * made to give ground from re-taking it in the same pass.
 */
export interface ClearanceRetry {
  retryBlockedClearances(skipTrainIds?: ReadonlySet<string>): ReadonlyArray<SchedulerEffect>;
}

/** Move a train's schedule on to its next stop and plan the leg there. */
export interface ScheduleAdvance {
  advanceScheduleAndReplan(train: TrainState): ReadonlyArray<SchedulerEffect>;
}
