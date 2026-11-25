import type { SchedulerEffect } from './effects.js';

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
