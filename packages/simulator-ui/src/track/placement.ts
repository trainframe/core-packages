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
import {
  type RotationDeg,
  type TrackPiece,
  type TrackPieceType,
  getEndpoints,
  isDevicePiece,
} from './pieces.js';

/**
 * How near a click must fall to an open endpoint for the new piece to connect
 * to it (mm). Kept comfortably below the spacing of independently-placed
 * pieces so clicking in open space still drops a free-standing piece.
 */
export const CONNECT_CAPTURE_MM = 60;

/**
 * How near a dropped/moved device piece (train/gate/carriage) must fall to a
 * track marker (a non-device piece's centre) to snap onto it (mm). Generous —
 * pieces are ~200 mm long, so half a piece-length lets an operator drop a train
 * roughly on a piece and have it land cleanly on that piece's marker. This is
 * what makes "placement point == spawn point": the snapped centre is the marker
 * the simulator spawns the train onto (`nearestStartEdge`, distance 0).
 */
export const DEVICE_SNAP_CAPTURE_MM = 120;

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

/**
 * Place a candidate so its local endpoint `localEp` (in piece-local
 * coordinates, piece at origin, unrotated) lands exactly on `anchor` with its
 * rail anti-parallel — i.e. the track continues rather than doubling back.
 * Shared by both placement paths so the snap maths lives in one place.
 */
function snapToAnchor(
  localEp: { readonly x: number; readonly y: number; readonly outgoingAngleDeg: number },
  anchor: WorldEndpoint,
): Placement {
  const rotationDeg = toRotationDeg(anchor.outgoingAngleDeg + 180 - localEp.outgoingAngleDeg);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // The endpoint after rotation about the piece origin.
  const rotatedX = localEp.x * cos - localEp.y * sin;
  const rotatedY = localEp.x * sin + localEp.y * cos;
  // Offset the origin so the rotated endpoint lands exactly on the anchor.
  return { x: anchor.x - rotatedX, y: anchor.y - rotatedY, rotationDeg, connected: true };
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
 * The nearest track marker (a non-device piece's centre) to `(x, y)` within
 * `DEVICE_SNAP_CAPTURE_MM`, or `undefined` if none is in reach. Device pieces
 * (train/gate/carriage) are NOT markers — `emitMarkers` skips them and so does
 * the simulator's spawn selector — so they are excluded as snap candidates.
 * Snapping a device piece onto this centre makes its on-canvas position equal
 * the marker the simulator spawns it onto (`nearestStartEdge`, distance 0).
 */
function nearestMarkerCentre(
  x: number,
  y: number,
  pieces: ReadonlyArray<TrackPiece>,
): { x: number; y: number } | undefined {
  let best: { x: number; y: number } | undefined;
  let bestDist = DEVICE_SNAP_CAPTURE_MM;
  for (const p of pieces) {
    if (isDevicePiece(p.type)) continue;
    const d = distance(x, y, p.position.x, p.position.y);
    if (d <= bestDist) {
      bestDist = d;
      best = { x: p.position.x, y: p.position.y };
    }
  }
  return best;
}

/**
 * Placement for a device piece (train/gate/carriage) dropped/moved to
 * `(x, y)`: snap onto the nearest track marker within `DEVICE_SNAP_CAPTURE_MM`
 * so it rides the rail and its position equals the simulator's spawn point;
 * otherwise drop it free at `(x, y)` keeping `rotationDeg`. Orientation along
 * the spawn edge is applied separately by the composition layer (it needs the
 * compiled layout / spawn-edge selector, which this pure module must not import
 * to avoid a sim→track cycle).
 */
function placeDevicePiece(
  x: number,
  y: number,
  rotationDeg: RotationDeg,
  pieces: ReadonlyArray<TrackPiece>,
): Placement {
  const marker = nearestMarkerCentre(x, y, pieces);
  if (marker === undefined) {
    return { x, y, rotationDeg, connected: false };
  }
  return { x: marker.x, y: marker.y, rotationDeg, connected: true };
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
  // No endpoints → device piece (train/gate/carriage): snap onto the nearest
  // track marker within reach so it lands on the rail (== the sim spawn point),
  // else drop where clicked.
  if (entry === undefined) {
    return placeDevicePiece(clickX, clickY, 0, pieces);
  }

  const anchor = nearestOpenEndpoint(clickX, clickY, pieces);
  if (anchor === undefined) {
    return { x: clickX, y: clickY, rotationDeg: 0, connected: false };
  }

  // Snap the candidate's entry endpoint onto the anchor, oriented to continue.
  return snapToAnchor(entry, anchor);
}

/**
 * The best (piece-endpoint, neighbour-open-endpoint) pair to snap together: the
 * closest pair within `CONNECT_CAPTURE_MM`, or `undefined` if none is in reach.
 * `pieceEndpoints` are the dragged piece's endpoints in *world* space at its
 * current cursor pose; `openEnds` are the neighbours' open endpoints.
 */
function bestEndpointPair(
  pieceEndpoints: ReadonlyArray<WorldEndpoint>,
  openEnds: ReadonlyArray<WorldEndpoint>,
): { readonly pieceEndpointIndex: number; readonly anchor: WorldEndpoint } | undefined {
  let best: { pieceEndpointIndex: number; anchor: WorldEndpoint } | undefined;
  let bestDist = CONNECT_CAPTURE_MM;
  for (let i = 0; i < pieceEndpoints.length; i++) {
    const pe = pieceEndpoints[i];
    if (pe === undefined) continue;
    for (const anchor of openEnds) {
      const d = distance(pe.x, pe.y, anchor.x, anchor.y);
      if (d <= bestDist) {
        bestDist = d;
        best = { pieceEndpointIndex: i, anchor };
      }
    }
  }
  return best;
}

/**
 * Where an already-placed `piece` being dragged to cursor `(cursorXMm,
 * cursorYMm)` should land, given the other placed `others`.
 *
 * Unlike {@link computePlacement} (which keys off the *cursor* falling near a
 * joint — right for click/drop-to-place), this keys off the dragged piece's own
 * *endpoints*: when any of the piece's ends comes within `CONNECT_CAPTURE_MM` of
 * a neighbour's open end, the piece snaps so those two ends meet and the rails
 * continue. That's the intuitive "bring two pieces' ends together and they
 * click" behaviour — the piece's centre may be far from the joint.
 *
 * When nothing is in reach the piece is dropped free at the cursor, keeping its
 * current rotation so a free move doesn't surprise-rotate it.
 *
 * @pure
 */
export function computeMovePlacement(
  piece: TrackPiece,
  cursorXMm: number,
  cursorYMm: number,
  others: ReadonlyArray<TrackPiece>,
): Placement {
  const free: Placement = {
    x: cursorXMm,
    y: cursorYMm,
    rotationDeg: piece.rotationDeg,
    connected: false,
  };
  // Local endpoints (origin, unrotated, current flip) — the candidate's own
  // ends in piece-local coordinates. Device pieces have none → snap onto the
  // nearest track marker (rail) within reach instead of dropping free.
  const localEndpoints = getEndpoints({ ...piece, position: { x: 0, y: 0 }, rotationDeg: 0 });
  if (localEndpoints.length === 0) {
    return placeDevicePiece(cursorXMm, cursorYMm, piece.rotationDeg, others);
  }

  // The same endpoints in world space at the piece's current cursor pose, used
  // only to decide which end is nearest a neighbour's open end. Index i here
  // corresponds to index i in `localEndpoints` (rotation/translation reorder
  // nothing).
  const atCursor = getEndpoints({ ...piece, position: { x: cursorXMm, y: cursorYMm } });
  const best = bestEndpointPair(atCursor, openEndpoints(others));
  if (best === undefined) return free;
  const localEp = localEndpoints[best.pieceEndpointIndex];
  if (localEp === undefined) return free;
  return snapToAnchor(localEp, best.anchor);
}
