/**
 * Carriage coupling detection and physics positioning for the toy table.
 *
 * A carriage is "coupled" to a train when its centre is within
 * COUPLING_DISTANCE_MM of the train's centre OR of another carriage already
 * coupled to that train. Coupling is computed each render from the pieces
 * array — it is derived state, never stored.
 *
 * Ties (a carriage equidistant from two live trains) are resolved by which
 * train appears first in the pieces array.
 *
 * Once coupled, each carriage (and the train itself) is given a
 * `WorldPosition` derived from the train's simulated `distance_into_edge_mm`.
 * The formula is a linear interpolation along the current edge endpoints,
 * with carriages placed at fixed intervals behind the train.
 */

import type { TrackPiece } from './pieces.js';

/** Centre-to-centre carriage spacing in mm (train head → first carriage → …).
 *  A carriage body is ~60 mm long, so this sits just above that to leave a small
 *  coupling gap between wagons rather than letting them overlap. */
export const CARRIAGE_SPACING_MM = 68;

/** A rendered world position for a piece on the canvas. */
export interface WorldPosition {
  readonly x: number;
  readonly y: number;
  /** Degrees clockwise from east (SVG convention, matching piece.rotationDeg). */
  readonly rotationDeg: number;
}

/**
 * Compute the world position of a piece placed along an edge at a given
 * distance from the edge start.
 *
 * `fromPos` / `toPos` are the world-space mm coordinates of the edge's start
 * and end markers. `edgeLengthMm` is the total length of the edge (used only
 * for normalisation, not clamping — callers are responsible for clamping `d`).
 *
 * `distanceMm` is the piece's distance from `fromPos` along the edge.
 * A value of 0 places the piece at `fromPos`; `edgeLengthMm` places it at
 * `toPos`.
 *
 * Returns the interpolated (x, y) and the heading angle (atan2 of the edge
 * direction) as `rotationDeg`.
 *
 * @pure — no side effects, no I/O, fully deterministic.
 */
export function carriageWorldPos(
  fromPos: { readonly x: number; readonly y: number },
  toPos: { readonly x: number; readonly y: number },
  edgeLengthMm: number,
  distanceMm: number,
): WorldPosition {
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const t = edgeLengthMm > 0 ? distanceMm / edgeLengthMm : 0;
  const x = fromPos.x + t * dx;
  const y = fromPos.y + t * dy;
  const rotationDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return { x, y, rotationDeg };
}

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
