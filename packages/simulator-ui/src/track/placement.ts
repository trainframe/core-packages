/**
 * Placement geometry for the visual track builder.
 *
 * When an operator places a track piece next to existing track, the piece
 * should *continue* that track: its open end should snap onto the neighbour's
 * open end and it should rotate so the two rails meet head-to-head. Without
 * this, building anything but a straight line by hand is impossible — you can
 * drop a curve but then have to rotate it, which moves its endpoints back off
 * the joint. Orienting at placement time is what every real track editor does
 * and is what lets eight curves be clicked into a closed circle.
 *
 * This module is pure geometry: `(click, type, existing pieces) → placement`.
 * No React, no DOM, no I/O — so it can be unit-tested directly and reused by
 * both the click-to-place and (future) drag-to-place paths.
 */

import { SNAP_DISTANCE } from './layout-from-pieces.js';
import { type RotationDeg, type TrackPiece, type TrackPieceType, getEndpoints } from './pieces.js';

/**
 * How near a click must fall to an open endpoint for the new piece to connect
 * to it (mm). Kept comfortably below the spacing of independently-placed
 * pieces so clicking in open space still drops a free-standing piece.
 */
export const CONNECT_CAPTURE_MM = 60;

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly rotationDeg: RotationDeg;
  /** True when the piece snapped + oriented onto a neighbour's open endpoint;
   * false when it was dropped free at the click point. */
  readonly connected: boolean;
}

interface WorldEndpoint {
  readonly x: number;
  readonly y: number;
  readonly outgoingAngleDeg: number;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function normaliseAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Round to the nearest 45° and return it as a `RotationDeg`. */
function toRotationDeg(deg: number): RotationDeg {
  return ((Math.round(normaliseAngle(deg) / 45) * 45) % 360) as RotationDeg;
}

/** Every endpoint of every placed piece, in world space. */
function allEndpoints(pieces: ReadonlyArray<TrackPiece>): WorldEndpoint[] {
  const all: WorldEndpoint[] = [];
  for (const piece of pieces) {
    for (const ep of getEndpoints(piece)) {
      all.push({ x: ep.x, y: ep.y, outgoingAngleDeg: ep.outgoingAngleDeg });
    }
  }
  return all;
}

/** True when `ep` coincides (within `SNAP_DISTANCE`) with some other endpoint. */
function isCoincidentWithAnother(ep: WorldEndpoint, all: ReadonlyArray<WorldEndpoint>): boolean {
  for (const other of all) {
    if (other === ep) continue;
    if (distance(ep.x, ep.y, other.x, other.y) <= SNAP_DISTANCE) return true;
  }
  return false;
}

/**
 * Endpoints of existing track that are *open* — not already coincident with
 * another endpoint (within `SNAP_DISTANCE`). These are the joints a new piece
 * can attach to. Device pieces (train/gate/carriage) have no endpoints and so
 * contribute nothing here.
 */
function openEndpoints(pieces: ReadonlyArray<TrackPiece>): WorldEndpoint[] {
  const all = allEndpoints(pieces);
  return all.filter((ep) => !isCoincidentWithAnother(ep, all));
}

/** The open endpoint nearest the click, or `undefined` if none is in range. */
function nearestOpenEndpoint(
  clickX: number,
  clickY: number,
  pieces: ReadonlyArray<TrackPiece>,
): WorldEndpoint | undefined {
  let best: WorldEndpoint | undefined;
  let bestDist = CONNECT_CAPTURE_MM;
  for (const ep of openEndpoints(pieces)) {
    const d = distance(clickX, clickY, ep.x, ep.y);
    if (d <= bestDist) {
      bestDist = d;
      best = ep;
    }
  }
  return best;
}

/**
 * The open endpoint a piece dropped at `(clickX, clickY)` would snap onto, or
 * `null` if nothing is in reach. Type-independent (it's the nearest open
 * endpoint within the capture radius) — used to highlight the join during a
 * drag, before the dragged piece type is known.
 */
export function nearestConnectablePoint(
  clickX: number,
  clickY: number,
  pieces: ReadonlyArray<TrackPiece>,
): { x: number; y: number } | null {
  const ep = nearestOpenEndpoint(clickX, clickY, pieces);
  return ep === undefined ? null : { x: ep.x, y: ep.y };
}

/**
 * Where a newly-placed piece of `type` should land for a click at
 * `(clickX, clickY)` given the already-placed `pieces`.
 *
 * If the click falls within `CONNECT_CAPTURE_MM` of an open endpoint, the new
 * piece's first endpoint is snapped exactly onto that endpoint and the piece is
 * rotated (to the nearest 45°) so its incoming rail is anti-parallel to the
 * neighbour's outgoing rail — i.e. the track continues smoothly. Otherwise the
 * piece is dropped, unrotated, at the click point.
 *
 * Device pieces have no endpoints and are always placed free at the click.
 *
 * @pure
 */
export function computePlacement(
  clickX: number,
  clickY: number,
  type: TrackPieceType,
  pieces: ReadonlyArray<TrackPiece>,
  flipped = false,
): Placement {
  // Local endpoints of the candidate: a piece at the origin, unrotated (but
  // mirrored if flipped), gives its endpoints in piece-local coordinates with
  // `outgoingAngleDeg` equal to each endpoint's local angle.
  const localEndpoints = getEndpoints({
    id: '__placement_candidate__',
    type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
    flipped,
  });
  const entry = localEndpoints[0];
  // No endpoints → device piece (train/gate/carriage): drop where clicked.
  if (entry === undefined) {
    return { x: clickX, y: clickY, rotationDeg: 0, connected: false };
  }

  const anchor = nearestOpenEndpoint(clickX, clickY, pieces);
  if (anchor === undefined) {
    return { x: clickX, y: clickY, rotationDeg: 0, connected: false };
  }

  // Rotate the piece so its entry rail is anti-parallel to the anchor's
  // outgoing rail (the joint continues rather than doubling back).
  const rotationDeg = toRotationDeg(anchor.outgoingAngleDeg + 180 - entry.outgoingAngleDeg);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // The entry endpoint after rotation about the piece origin.
  const rotatedEntryX = entry.x * cos - entry.y * sin;
  const rotatedEntryY = entry.x * sin + entry.y * cos;
  // Offset the origin so the rotated entry endpoint lands exactly on the anchor.
  return {
    x: anchor.x - rotatedEntryX,
    y: anchor.y - rotatedEntryY,
    rotationDeg,
    connected: true,
  };
}
