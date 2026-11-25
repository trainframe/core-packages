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
 *
 * REST-DOMAIN CONTRACT. Placement operates on REST geometry (`TrackPiece[]`),
 * never flex-resolved `EffectivePiece[]`. It computes a new piece's REST pose by
 * snapping to a neighbour's REST endpoint; the flex layer's forward kinematics
 * (`applyFlex`) then positions that piece at the actual (possibly flexed) joint.
 * Snapping against effective geometry would double-count the neighbour's flex
 * via FK and leave a gap at the joint (see flex-attach.test.ts). The branded
 * `EffectivePiece` type is deliberately NOT assignable to `TrackPiece`, so
 * passing effective geometry here is a compile error rather than a silent bug.
 */

import { SNAP_DISTANCE } from './layout-from-pieces.js';
import {
  type RotationDeg,
  type TrackPiece,
  type TrackPieceType,
  getCentreLinePathAt,
  getEndpoints,
  isDevicePiece,
  layerOf,
} from './pieces.js';

/**
 * How near a click must fall to an open endpoint for the new piece to connect
 * to it (mm). Kept comfortably below the spacing of independently-placed
 * pieces so clicking in open space still drops a free-standing piece.
 */
export const CONNECT_CAPTURE_MM = 60;

/**
 * How near a dropped/moved device piece (train/gate/carriage) must fall to a
 * rail centre-line to snap onto it (mm). Tight on purpose: a device dropped ON
 * the track (within a plank half-width, 13 mm, of the rail) snaps cleanly onto
 * it; a device dropped OFF the track STAYS WHERE PUT (the operator's expectation
 * — a train placed in open space is not on the railway). A generous capture used
 * to yank an off-track drop onto a distant rail.
 */
export const DEVICE_SNAP_CAPTURE_MM = 13;

export interface Placement {
  readonly x: number;
  readonly y: number;
  /** Degrees. Grid (45°) for a new/snapped piece; may be continuous when a
   *  moved piece carries a baked off-grid rotation. */
  readonly rotationDeg: number;
  /** True when the piece snapped + oriented onto a neighbour's open endpoint;
   * false when it was dropped free at the click point. */
  readonly connected: boolean;
}

/* Minimal geometry a world-space endpoint must carry. Sufficient for distance
 * and layer tests (e.g. bestEndpointPair) that do not need piece identity. */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
  readonly outgoingAngleDeg: number;
  /** Height layer of this endpoint (from `TrackEndpoint.layer`). All snap tests
   * gate on layer equality so a piece on one deck never connects to a joint on
   * another beneath it. */
  readonly layer: number;
}

/* Full world-space endpoint: geometry plus the owning piece's ID. Required by
 * isCoincidentWithAnother, which must skip a piece's own sibling endpoints. */
export interface WorldEndpoint extends WorldPoint {
  /** ID of the piece that owns this endpoint. Used to avoid treating a piece's
   * own sibling endpoints as blocking occupancy — otherwise a piece shorter than
   * SNAP_DISTANCE marks its own ends as closed. */
  readonly pieceId: string;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function normaliseAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Every endpoint of every placed piece, in world space. */
function allEndpoints(pieces: ReadonlyArray<TrackPiece>): WorldEndpoint[] {
  const all: WorldEndpoint[] = [];
  for (const piece of pieces) {
    for (const ep of getEndpoints(piece)) {
      all.push({
        x: ep.x,
        y: ep.y,
        outgoingAngleDeg: ep.outgoingAngleDeg,
        layer: ep.layer,
        pieceId: piece.id,
      });
    }
  }
  return all;
}

/** True when `ep` coincides (within `SNAP_DISTANCE`, on the SAME layer) with
 * some other endpoint. The layer-equality test is a precondition of the
 * distance test so two stacked endpoints (0 mm apart in plan, different layers)
 * are NOT treated as coincident — a bridge deck endpoint above a ground joint
 * stays open. A piece's own sibling endpoint is always skipped — otherwise a
 * piece shorter than SNAP_DISTANCE marks its own ends as closed. */
function isCoincidentWithAnother(ep: WorldEndpoint, all: ReadonlyArray<WorldEndpoint>): boolean {
  for (const other of all) {
    if (other === ep) continue;
    /* A piece's own sibling endpoint can never "occupy" it — otherwise a piece
     * shorter than SNAP_DISTANCE (the 30 mm straight) marks its own ends closed. */
    if (other.pieceId === ep.pieceId) continue;
    if (other.layer !== ep.layer) continue;
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
export function openEndpoints(
  pieces: ReadonlyArray<TrackPiece>,
  excludePieceId?: string,
): WorldEndpoint[] {
  const all = allEndpoints(pieces.filter((p) => p.id !== excludePieceId));
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
  /* Align the candidate's entry CONTINUOUSLY anti-parallel to the anchor's actual
     outgoing heading — never rounded to the 45° grid. For an on-grid neighbour the
     result is the clean grid angle anyway; for a BAKED, off-grid (flexed) end this
     is what keeps the new joint continuous instead of kinking it by the flex angle
     (the single coordinate frame means a stored rotationDeg can be off-grid). */
  const rotationDeg = normaliseAngle(anchor.outgoingAngleDeg + 180 - localEp.outgoingAngleDeg);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // The endpoint after rotation about the piece origin.
  const rotatedX = localEp.x * cos - localEp.y * sin;
  const rotatedY = localEp.x * sin + localEp.y * cos;
  // Offset the origin so the rotated endpoint lands exactly on the anchor.
  return { x: anchor.x - rotatedX, y: anchor.y - rotatedY, rotationDeg, connected: true };
}

/**
 * The open endpoint nearest the click, or `undefined` if none is in range.
 * When `activeLayer` is given, only joints on that layer are eligible — so a
 * piece being placed on the upper deck ignores the ground joints beneath it
 * (and vice versa). Omit it (the mid-drag highlight, before the piece's layer
 * is known) to consider all layers.
 */
function nearestOpenEndpoint(
  clickX: number,
  clickY: number,
  pieces: ReadonlyArray<TrackPiece>,
  activeLayer?: number,
): WorldEndpoint | undefined {
  let best: WorldEndpoint | undefined;
  let bestDist = CONNECT_CAPTURE_MM;
  for (const ep of openEndpoints(pieces)) {
    if (activeLayer !== undefined && ep.layer !== activeLayer) continue;
    const d = distance(clickX, clickY, ep.x, ep.y);
    if (d <= bestDist) {
      bestDist = d;
      best = ep;
    }
  }
  return best;
}

/**
 * The nearest point ON a track rail (a non-device piece's CENTRE-LINE, not its
 * centre) to `(x, y)` within `DEVICE_SNAP_CAPTURE_MM`, or `undefined` if no rail
 * is in reach. Device pieces (train/gate/carriage) carry no rail and are excluded.
 * Snapping a dropped device to the nearest rail point — the perpendicular foot —
 * keeps it WHERE IT WAS DROPPED along the track (the operator's "it stays put"),
 * rather than jerking it to the piece centre up to the whole capture radius away;
 * it still rides the rail, and `nearestStartEdge` still resolves the on-rail point
 * to the right spawn marker, so power-on does not pop.
 */
/** The nearest point on ONE piece's rail centre-line to `(x, y)`, with its
 *  distance — sampled over both half-paths (centre→each endpoint). `undefined`
 *  for a piece with no centre-line (a device). */
function nearestPointOnPieceRail(
  piece: TrackPiece,
  x: number,
  y: number,
): { readonly x: number; readonly y: number; readonly dist: number } | undefined {
  const pose = { x: piece.position.x, y: piece.position.y, rotationDeg: piece.rotationDeg };
  const SAMPLES = 12;
  let best: { x: number; y: number; dist: number } | undefined;
  const endpointCount = getEndpoints(piece).length;
  for (let i = 0; i < endpointCount; i++) {
    const path = getCentreLinePathAt(piece, pose, i);
    if (path === undefined) continue;
    for (let s = 0; s <= SAMPLES; s++) {
      const pt = path.at((s / SAMPLES) * path.length);
      const d = distance(x, y, pt.x, pt.y);
      if (best === undefined || d < best.dist) best = { x: pt.x, y: pt.y, dist: d };
    }
  }
  return best;
}

function nearestRailPoint(
  x: number,
  y: number,
  pieces: ReadonlyArray<TrackPiece>,
  activeLayer: number,
): { x: number; y: number } | undefined {
  let best: { x: number; y: number } | undefined;
  let bestDist = DEVICE_SNAP_CAPTURE_MM;
  for (const p of pieces) {
    if (isDevicePiece(p.type)) continue;
    // Gate on layer so a train dropped on the upper deck snaps to an upper rail,
    // not the ground rail directly beneath it.
    if (layerOf(p) !== activeLayer) continue;
    const cand = nearestPointOnPieceRail(p, x, y);
    if (cand !== undefined && cand.dist <= bestDist) {
      bestDist = cand.dist;
      best = { x: cand.x, y: cand.y };
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
  rotationDeg: number,
  pieces: ReadonlyArray<TrackPiece>,
  activeLayer: number,
): Placement {
  const onRail = nearestRailPoint(x, y, pieces, activeLayer);
  if (onRail === undefined) {
    return { x, y, rotationDeg, connected: false };
  }
  return { x: onRail.x, y: onRail.y, rotationDeg, connected: true };
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
 * rotated so its incoming rail is anti-parallel to the neighbour's actual
 * outgoing rail — continuously, not quantised to the grid, so it stays flush
 * even on a baked off-grid (flexed) end. Otherwise the piece is dropped,
 * unrotated, at the click point.
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
  activeLayer = 0,
  lengthMm?: number,
): Placement {
  // Local endpoints of the candidate: a piece at the origin, unrotated (but
  // mirrored if flipped), gives its endpoints in piece-local coordinates with
  // `outgoingAngleDeg` equal to each endpoint's local angle. The candidate
  // carries `activeLayer` so its own endpoints sit on the active deck and the
  // snap filter is gated correctly — without this an upper-deck piece would
  // default to layer 0 and wrongly snap to ground joints beneath it.
  const candidate: TrackPiece = {
    id: '__placement_candidate__',
    type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
    flipped,
    ...(activeLayer !== 0 ? { layer: activeLayer } : {}),
    /* A length-variant straight's own half-length sets where its centre must sit
       for its entry to land on the anchor; without it the candidate snaps as a
       200 mm plank and a shorter variant lands short of the joint. */
    ...(lengthMm !== undefined ? { lengthMm } : {}),
  };
  const localEndpoints = getEndpoints(candidate);
  const entry = localEndpoints[0];
  // No endpoints → device piece (train/gate/carriage): snap onto the nearest
  // track marker within reach so it lands on the rail (== the sim spawn point),
  // else drop where clicked.
  if (entry === undefined) {
    return placeDevicePiece(clickX, clickY, 0, pieces, activeLayer);
  }

  // Anchor only onto joints on the candidate's entry layer. For a non-ramp
  // piece every endpoint shares the active layer; for a ramp the entry is on
  // the active layer (its raised exit snaps later, from the upper deck).
  const anchor = nearestOpenEndpoint(clickX, clickY, pieces, entry.layer);
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
  pieceEndpoints: ReadonlyArray<WorldPoint>,
  openEnds: ReadonlyArray<WorldEndpoint>,
  maxDist: number = CONNECT_CAPTURE_MM,
): { readonly pieceEndpointIndex: number; readonly anchor: WorldEndpoint } | undefined {
  let best: { pieceEndpointIndex: number; anchor: WorldEndpoint } | undefined;
  let bestDist = maxDist;
  for (let i = 0; i < pieceEndpoints.length; i++) {
    const pe = pieceEndpoints[i];
    if (pe === undefined) continue;
    for (const anchor of openEnds) {
      // Only pair endpoints on the same layer — a dragged upper-deck end never
      // clicks onto a ground joint beneath it (and a ramp's raised exit only
      // pairs with upper joints).
      if (anchor.layer !== pe.layer) continue;
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
    return placeDevicePiece(cursorXMm, cursorYMm, piece.rotationDeg, others, layerOf(piece));
  }

  // The same endpoints in world space at the piece's current cursor pose, used
  // only to decide which end is nearest a neighbour's open end. Index i here
  // corresponds to index i in `localEndpoints` (rotation/translation reorder
  // nothing).
  const atCursor = getEndpoints({ ...piece, position: { x: cursorXMm, y: cursorYMm } });
  /* Capture reaches the piece's own half-extent: dragging a piece so its BODY
     overlaps a neighbour (dropping it "on/against" the join, centre near the
     neighbour's open end) attaches it — its near end can be up to a half-extent
     from the open end. Without this a drop overlapping a neighbour found no pair
     within the bare CONNECT_CAPTURE_MM and landed RAW, overlapping the neighbour
     — reading as the dropped piece "vanishing". The teleport guard below still
     bounds the result so a far graze can't fling the piece across a joint. */
  const halfExtent = Math.max(...localEndpoints.map((e) => Math.hypot(e.x, e.y)));
  const best = bestEndpointPair(
    atCursor,
    openEndpoints(others),
    Math.max(CONNECT_CAPTURE_MM, halfExtent),
  );
  if (best === undefined) return free;
  const localEp = localEndpoints[best.pieceEndpointIndex];
  if (localEp === undefined) return free;
  const snapped = snapToAnchor(localEp, best.anchor);
  /* Anti-parallel snapping always extends the piece AWAY from the joint, so when
     a FAR endpoint grazes capture the whole piece is flung to the OTHER side of
     the joint — it "teleports to the end of the track", far from the cursor. The
     piece is centre-tracked on the cursor during a move, so reject a snap that
     jumps its centre too far. The allowance is the piece's own half-extent (the
     centre legitimately lands up to one half-extent away when an end is brought to
     a joint) plus a capture radius; a fling crosses the joint and exceeds that. */
  if (distance(snapped.x, snapped.y, cursorXMm, cursorYMm) > halfExtent + CONNECT_CAPTURE_MM) {
    return free;
  }
  return snapped;
}
