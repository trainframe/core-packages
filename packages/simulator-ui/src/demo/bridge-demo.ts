/**
 * A deterministic two-train BRIDGE demo layout, built with a small turtle.
 *
 * The scene is two INDEPENDENT closed loops that share no junction (sidestepping
 * the switch-contention blocker): each loop is a clean cycle with no dead ends,
 * so a train under `begin_exploration` circulates forever.
 *
 *  - Loop B is ground-only (layer 0) with a station.
 *  - Loop A is mostly ground (with a ground station) but ramps UP onto a
 *    layer-1 deck — carrying an upper station — that crosses directly OVER a
 *    loop-B edge, then ramps DOWN and closes on the ground.
 *
 * The two loops are positioned so loop A's deck physically crosses over a loop-B
 * straight in 2D, yet they share NO endpoints/markers: the over-crossing is a
 * layer-1 deck edge passing above a layer-0 edge (a true bridge, not a merge).
 *
 * Pure geometry: no React, no I/O, no clock, no randomness — given no input it
 * always returns the same pieces.
 */

import {
  type RotationDeg,
  type TrackPiece,
  type TrackPieceType,
  getEndpoints,
} from '../track/pieces.js';

// ---------------------------------------------------------------------------
// Turtle
// ---------------------------------------------------------------------------

/**
 * The turtle's pose between placements: the world point a new piece's connect
 * endpoint must land on, the direction the rail points there (degrees,
 * clockwise from east), and the height layer it sits on.
 */
interface Cursor {
  readonly x: number;
  readonly y: number;
  readonly dir: number;
  readonly layer: number;
}

interface PlaceOpts {
  /** The id of the piece to place (so tests can address its marker `M-{id}`). */
  readonly id: string;
  /** Mirror the piece (left- vs right-hand curve, junction divert side). */
  readonly flipped?: boolean;
  /**
   * Which local endpoint index connects to the cursor (default 0). The OTHER
   * index becomes the exit. `connectVia: 1` is REQUIRED for a descent ramp:
   * connect the ramp's upper (index-1, layer+1) endpoint to a layer-1 deck
   * cursor; the exit is then the index-0 (ground) end, so the cursor returns to
   * the ground layer.
   */
  readonly connectVia?: 0 | 1;
}

/** Round an arbitrary angle to the nearest 45°, normalised into [0, 315]. */
function toRotationDeg(deg: number): RotationDeg {
  return ((((Math.round(deg / 45) * 45) % 360) + 360) % 360) as RotationDeg;
}

/** Conditionally-spread layer/flipped so we never write `layer: undefined` /
 * `flipped: undefined` (exactOptionalPropertyTypes). Layer 0 is omitted. */
function pieceExtras(
  flipped: boolean | undefined,
  layer: number,
): Pick<TrackPiece, 'flipped' | 'layer'> {
  return {
    ...(flipped === true ? { flipped: true } : {}),
    ...(layer !== 0 ? { layer } : {}),
  };
}

/**
 * Place a track piece so its connect endpoint lands exactly on `cursor`, its
 * rail anti-parallel (the track continues rather than doubling back), then
 * return the new cursor read from the EXIT endpoint's world pose.
 *
 * The rotation/position maths mirrors `placement.ts`'s `snapToAnchor`: rotate
 * the connect endpoint by R about the piece origin and offset the origin so the
 * rotated endpoint lands on the cursor, with
 *   R = round45(cursor.dir + 180 − connectLocal.outgoingAngleDeg).
 * `connectLocal` is read from a PROBE piece built at the origin (rotation 0,
 * same flipped/layer), so its local endpoints already carry the mirror; the
 * real piece is then re-read with `getEndpoints` for a consistent exit cursor.
 */
function place(
  pieces: TrackPiece[],
  cursor: Cursor,
  type: TrackPieceType,
  opts: PlaceOpts,
): Cursor {
  const connectVia = opts.connectVia ?? 0;
  const exitVia = connectVia === 0 ? 1 : 0;

  // Probe at LAYER 0 to read LOCAL endpoints (already mirrored for `flipped`).
  // At layer 0 each endpoint's `.layer` IS its layerDelta (0 for ordinary
  // pieces and a ramp's index-0; 1 for a ramp's index-1). The piece's own base
  // layer is then `cursor.layer − connectLocal.layer`, so the connect endpoint
  // matches the cursor's layer: a descent ramp (cursor.layer 1, connectVia 1)
  // gets base layer 0, and its index-0 exit returns the cursor to the ground.
  const probe0: TrackPiece = {
    id: '__probe__',
    type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
    ...(opts.flipped === true ? { flipped: true } : {}),
  };
  const localEps = getEndpoints(probe0);
  const connectLocal = localEps[connectVia];
  if (connectLocal === undefined) {
    throw new Error(`place: piece ${type} has no endpoint at connectVia ${connectVia}`);
  }
  const baseLayer = cursor.layer - connectLocal.layer;
  const extras = pieceExtras(opts.flipped, baseLayer);

  const rotationDeg = toRotationDeg(cursor.dir + 180 - connectLocal.outgoingAngleDeg);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedX = connectLocal.x * cos - connectLocal.y * sin;
  const rotatedY = connectLocal.x * sin + connectLocal.y * cos;

  const real: TrackPiece = {
    id: opts.id,
    type,
    position: { x: cursor.x - rotatedX, y: cursor.y - rotatedY },
    rotationDeg,
    tagged: false,
    ...extras,
  };
  pieces.push(real);

  // The new cursor is the exit endpoint's world pose. Re-read from the placed
  // piece so position, angle, and layer (including a ramp's +1) are consistent.
  const worldEps = getEndpoints(real);
  const exit = worldEps[exitVia];
  if (exit === undefined) {
    throw new Error(`place: piece ${type} has no endpoint at exitVia ${exitVia}`);
  }
  return { x: exit.x, y: exit.y, dir: exit.outgoingAngleDeg, layer: exit.layer };
}

// ---------------------------------------------------------------------------
// Demo layout
// ---------------------------------------------------------------------------

export interface BridgeDemo {
  readonly pieces: TrackPiece[];
  readonly trainAId: string;
  readonly trainBId: string;
  /** Every piece id whose device should go live (all track + the two trains).
   * `ToyHardware.syncLive` runs `bindIdentityTag`/`spawnPiece` on each, so the
   * sim emits `tag_observed` as trains cross markers — the demo's wire proof. */
  readonly liveIds: string[];
}

/**
 * Build a closed rounded-rectangle loop, ground level, on layer 0. Each corner
 * is two same-chirality 45° curves (= a 90° turn); the sides are straights with
 * one of them swapped for a station. Returns the cursor after the final corner
 * (which, when the side lengths balance, returns to the start pose — closing
 * the loop via endpoint clustering in `compileLayout`).
 *
 * `flipped: true` on every curve makes the loop turn consistently (clockwise on
 * screen, SVG y-down); equal straight counts on opposite sides close the
 * translation.
 */

/** A 90° corner = two flipped 45° curves (same chirality). */
function corner(pieces: TrackPiece[], cursor: Cursor, idPrefix: string, n: number): Cursor {
  let c = cursor;
  c = place(pieces, c, 'curve', { id: `${idPrefix}-c${n}a`, flipped: true });
  c = place(pieces, c, 'curve', { id: `${idPrefix}-c${n}b`, flipped: true });
  return c;
}

/** Build loop B: a ground rounded rectangle with one station. */
function buildLoopB(pieces: TrackPiece[], start: Cursor): void {
  let c = start;
  // Top side: station + straight.
  c = place(pieces, c, 'station', { id: 'lb-st0' });
  c = place(pieces, c, 'straight', { id: 'lb-s0' });
  c = corner(pieces, c, 'lb', 0);
  // Right side: two straights.
  c = place(pieces, c, 'straight', { id: 'lb-s1' });
  c = place(pieces, c, 'straight', { id: 'lb-s2' });
  c = corner(pieces, c, 'lb', 1);
  // Right side carries the over-crossing: loop A's layer-1 deck passes above
  // the lb-c0b–lb-s1 joint of this loop (see the over-crossing test).
  // Bottom side: two straights.
  c = place(pieces, c, 'straight', { id: 'lb-s3' });
  c = place(pieces, c, 'straight', { id: 'lb-s4' });
  c = corner(pieces, c, 'lb', 2);
  // Left side: two straights.
  c = place(pieces, c, 'straight', { id: 'lb-s5' });
  c = place(pieces, c, 'straight', { id: 'lb-s6' });
  corner(pieces, c, 'lb', 3);
}

/**
 * Build loop A: a ground rounded rectangle whose TOP side ramps UP onto a
 * layer-1 deck (straight + upper station) that crosses over loop B, then ramps
 * DOWN and continues on the ground, with a ground station on the bottom side.
 */
function buildLoopA(pieces: TrackPiece[], start: Cursor): void {
  let c = start;
  // Top side: ramp UP from ground onto the deck, deck straight, upper station,
  // deck straight, ramp DOWN back to ground. The cursor enters at layer 0; the
  // up-ramp's exit (index-1) is layer 1, the deck pieces sit on layer 1, and the
  // down-ramp's index-0 exit returns to layer 0. The deck edge (between two
  // layer-1 pieces) is the bridge that crosses over loop B.
  c = place(pieces, c, 'ramp', { id: 'la-rampUp' });
  c = place(pieces, c, 'straight', { id: 'la-deck0' });
  c = place(pieces, c, 'station', { id: 'la-deckSt' });
  c = place(pieces, c, 'straight', { id: 'la-deck1' });
  // Descent ramp: connect its UPPER (index-1) endpoint to the deck cursor; the
  // exit (index-0) drops back to ground.
  c = place(pieces, c, 'ramp', { id: 'la-rampDown', connectVia: 1 });
  c = corner(pieces, c, 'la', 0);
  // Right side: two straights.
  c = place(pieces, c, 'straight', { id: 'la-s0' });
  c = place(pieces, c, 'straight', { id: 'la-s1' });
  c = corner(pieces, c, 'la', 1);
  // Bottom side: ground station + four straights, balancing the 1020mm top side
  // (ramp+deck0+deckSt+deck1+ramp) so the rectangle closes (220 + 4×200 = 1020).
  c = place(pieces, c, 'station', { id: 'la-groundSt' });
  c = place(pieces, c, 'straight', { id: 'la-s2' });
  c = place(pieces, c, 'straight', { id: 'la-s2b' });
  c = place(pieces, c, 'straight', { id: 'la-s2c' });
  c = place(pieces, c, 'straight', { id: 'la-s2d' });
  c = corner(pieces, c, 'la', 2);
  // Left side: straights.
  c = place(pieces, c, 'straight', { id: 'la-s3' });
  c = place(pieces, c, 'straight', { id: 'la-s4' });
  corner(pieces, c, 'la', 3);
}

/** The shared train device-piece ids (device ids are `T-trainA`/`T-trainB`). */
const TRAIN_A_ID = 'trainA';
const TRAIN_B_ID = 'trainB';

/**
 * Build the full two-train bridge demo: two disjoint closed loops, a train on
 * each loop's ground part (placed at a marker centre so the sim spawns it at
 * distance 0), and the `liveIds` for staging.
 */
export function buildBridgeDemo(): BridgeDemo {
  const pieces: TrackPiece[] = [];

  // Loop B sits to the lower-left; loop A's deck reaches across its right side.
  buildLoopB(pieces, { x: 200, y: 460, dir: 0, layer: 0 });
  // Loop A starts on the GROUND up top; the up-ramp lifts onto the deck, which
  // runs left→right OVER loop B's RIGHT side. The start cursors are tuned so the
  // deck edge la-deckSt–la-deck1 (y=200, x≈710–920) passes above loop B's
  // lb-c0b–lb-s1 joint (x≈820) — the over-crossing the discriminating test
  // asserts.
  buildLoopA(pieces, { x: 200, y: 200, dir: 0, layer: 0 });

  // Trains: snap each onto a ground marker centre of its loop.
  const aGround = pieces.find((p) => p.id === 'la-groundSt');
  const bMarker = pieces.find((p) => p.id === 'lb-s4');
  if (aGround === undefined || bMarker === undefined) {
    throw new Error('buildBridgeDemo: expected ground markers for train placement');
  }
  const trainA: TrackPiece = {
    id: TRAIN_A_ID,
    type: 'train',
    position: { x: aGround.position.x, y: aGround.position.y },
    rotationDeg: 0,
    tagged: false,
  };
  const trainB: TrackPiece = {
    id: TRAIN_B_ID,
    type: 'train',
    position: { x: bMarker.position.x, y: bMarker.position.y },
    rotationDeg: 0,
    tagged: false,
  };
  pieces.push(trainA, trainB);

  const liveIds = pieces.map((p) => p.id);

  return { pieces, trainAId: `T-${TRAIN_A_ID}`, trainBId: `T-${TRAIN_B_ID}`, liveIds };
}
