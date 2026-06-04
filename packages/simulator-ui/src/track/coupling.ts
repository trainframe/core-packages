/**
 * Carriage coupling detection for the toy table.
 *
 * A carriage is "coupled" to a train when its centre is within
 * COUPLING_DISTANCE_MM of the train's centre OR of another carriage already
 * coupled to that train. Coupling is computed each render from the pieces
 * array — it is derived state, never stored.
 *
 * Ties (a carriage equidistant from two live trains) are resolved by which
 * train appears first in the pieces array.
 */

import type { TrackPiece } from './pieces.js';

/** Centre-to-centre coupling distance in mm. */
export const COUPLING_DISTANCE_MM = 100;

/** Euclidean distance between two piece centres. */
function centreDist(a: TrackPiece, b: TrackPiece): number {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Check whether a candidate carriage is within coupling distance of any piece
 * already in the trail frontier.
 */
function isWithinReach(carriage: TrackPiece, frontier: ReadonlyArray<TrackPiece>): boolean {
  for (const anchor of frontier) {
    if (centreDist(anchor, carriage) <= COUPLING_DISTANCE_MM) {
      return true;
    }
  }
  return false;
}

/**
 * Flood-fill carriages onto a single train's trail.
 *
 * Starting from the live train, repeatedly pull in any unclaimed carriage
 * within COUPLING_DISTANCE_MM of any piece already in the trail (the train
 * itself or a previously attached carriage). Mutates `claimed` in place so
 * the caller can prevent two trains from grabbing the same carriage.
 */
function fillTrail(
  train: TrackPiece,
  unclaimed: ReadonlyArray<TrackPiece>,
  claimed: Set<string>,
): string[] {
  const trail: string[] = [];
  const frontier: TrackPiece[] = [train];

  let changed = true;
  while (changed) {
    changed = false;
    for (const carriage of unclaimed) {
      if (claimed.has(carriage.id)) continue;
      if (isWithinReach(carriage, frontier)) {
        trail.push(carriage.id);
        frontier.push(carriage);
        claimed.add(carriage.id);
        changed = true;
      }
    }
  }

  return trail;
}

/**
 * Compute carriage trails for all live trains in the pieces array.
 *
 * Returns a `Map` from train-piece-id to an ordered array of carriage-piece-ids
 * that are coupled to that train. Carriages are added to the trail via a
 * flood-fill: starting from the live train, any unclaimed carriage within
 * `COUPLING_DISTANCE_MM` of any piece already in the trail (the train itself
 * or another coupled carriage) is pulled in. The process repeats until no new
 * carriages are found. Trains are seeded in array order so the first live
 * train in pieces wins any equidistant tie.
 *
 * Carriages that are not within coupling distance of any live train are not
 * included in the returned map.
 */
export function computeTrainTrails(
  pieces: ReadonlyArray<TrackPiece>,
  liveIds: ReadonlySet<string>,
): Map<string, string[]> {
  const trails = new Map<string, string[]>();

  const liveTrains: TrackPiece[] = [];
  const unclaimedCarriages: TrackPiece[] = [];
  for (const p of pieces) {
    if (p.type === 'train' && liveIds.has(p.id)) {
      liveTrains.push(p);
    } else if (p.type === 'carriage') {
      unclaimedCarriages.push(p);
    }
  }

  if (liveTrains.length === 0 || unclaimedCarriages.length === 0) {
    return trails;
  }

  // Track which carriages have been claimed so two trains can't grab the same one.
  const claimed = new Set<string>();

  for (const train of liveTrains) {
    const trail = fillTrail(train, unclaimedCarriages, claimed);
    if (trail.length > 0) {
      trails.set(train.id, trail);
    }
  }

  return trails;
}
