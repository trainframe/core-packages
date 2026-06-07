/**
 * A deterministic two-train UNIFIED FLYOVER demo, built with a small turtle.
 *
 * The scene is ONE connected track (a "theta" graph): a ground main loop with
 * two junctions, J1 (diverge) and J2 (merge), joined by three chains —
 *
 *   - RETURN chain  J1.trunk(0) … ground … J2.trunk(0)   (carries ground station A)
 *   - MAIN chain    J1.through(1, 'main') … ground … J2.through(1)  (ground station B)
 *   - DECK chain    J1.branch(2, 'divert') … ramp UP … layer-1 deck (upper
 *                   station) … ramp DOWN … J2.branch(2)
 *
 * Both trains ENTER each junction via the unconstrained trunk side and LEAVE
 * via trunk on the far junction, so the MERGE at J2 needs no switch — block
 * exclusivity serialises the convergence (the compile test proves the
 * trunk-exit edge carries no `requires_switch_state`).
 *
 * The scheduler throws J1 to 'divert' for train A (up the bridge to the upper
 * station) and 'main' for train B (straight on along the ground). The MAIN
 * chain bumps UP in plan so a ground main-loop edge passes directly under a
 * layer-1 deck edge — a true over/under bridge (two edges crossing in 2D on
 * different layers, sharing no marker). The upper station is reachable ONLY
 * through the divert legs, so train A's schedule forces it over the flyover.
 *
 * Pure geometry: no React, no I/O, no clock, no randomness — given no input it
 * always returns the same pieces. The intricate junction-to-junction closure
 * was tuned against the compile test (see bridge-demo.test.ts); the comments
 * record the chain shapes so the layout can be reasoned about without re-deriving
 * the coordinates.
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
   * the ground layer. Also used to attach a junction by its `through` (index-1)
   * endpoint so its `trunk` (index-0) becomes the exit cursor.
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

/**
 * Read endpoint `n` of an already-placed piece as a fresh cursor. Needed to
 * branch off a junction's BRANCH endpoint (index 2): `place` can only exit
 * endpoints 0/1, so the deck chain is seeded from the junction's branch pose
 * read here.
 */
function endpointCursor(pieces: ReadonlyArray<TrackPiece>, id: string, n: number): Cursor {
  const piece = pieces.find((p) => p.id === id);
  if (piece === undefined) {
    throw new Error(`endpointCursor: no piece ${id}`);
  }
  const ep = getEndpoints(piece)[n];
  if (ep === undefined) {
    throw new Error(`endpointCursor: piece ${id} has no endpoint ${n}`);
  }
  return { x: ep.x, y: ep.y, dir: ep.outgoingAngleDeg, layer: ep.layer };
}

/** Two same-chirality 45° curves = a 90° corner. */
function corner(pieces: TrackPiece[], cursor: Cursor, idPrefix: string, flipped: boolean): Cursor {
  let c = cursor;
  c = place(pieces, c, 'curve', { id: `${idPrefix}a`, flipped });
  c = place(pieces, c, 'curve', { id: `${idPrefix}b`, flipped });
  return c;
}

// ---------------------------------------------------------------------------
// Layout ids
// ---------------------------------------------------------------------------

const TRAIN_A_ID = 'trainA';
const TRAIN_B_ID = 'trainB';

const JUNCTION_J1_ID = 'j1';
const JUNCTION_J2_ID = 'j2';

/** Ground station on the RETURN chain — train A's home / first stop. */
const GROUND_STATION_A_ID = 'rt-stationA';
/** Ground station on the MAIN chain — train B's home / first stop. */
const GROUND_STATION_B_ID = 'mn-stationB';
/** The UPPER station on the layer-1 deck — reachable only over the flyover. */
const UPPER_STATION_ID = 'la-deckSt';

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
  /** The two ground-station marker ids (`M-{pieceId}`). A starts on the first. */
  readonly groundStations: string[];
  /** The upper-station marker id (`M-{pieceId}`) on the layer-1 deck. */
  readonly upperStation: string;
  /** The DIVERGE junction marker id (`M-{pieceId}`). */
  readonly junctionId: string;
}

/**
 * Build the MAIN chain (train B's path): from J1's THROUGH endpoint, a ground
 * station, then a central UP bump (so a ground edge passes under the deck — the
 * over/under), landing on a freshly placed J2 via its THROUGH endpoint. J2 is
 * placed `connectVia: 1` so its TRUNK (index 0) becomes the cursor's exit and
 * faces the return chain, and its BRANCH (index 2) faces the deck descent.
 */
function buildMainChainAndJ2(pieces: TrackPiece[]): void {
  let c = endpointCursor(pieces, JUNCTION_J1_ID, 1); // J1 'main' (through), heading east
  c = place(pieces, c, 'station', { id: GROUND_STATION_B_ID });
  // Up bump: east → north, two risers (these cross UNDER the deck), north → east,
  // a top straight, east → south, two risers, south → east — back to the start y.
  c = corner(pieces, c, 'mn-c0', true); // east → north (up)
  c = place(pieces, c, 'straight', { id: 'mn-rup0' });
  c = place(pieces, c, 'straight', { id: 'mn-rup1' });
  c = corner(pieces, c, 'mn-c1', false); // north → east
  c = place(pieces, c, 'straight', { id: 'mn-top0' });
  c = corner(pieces, c, 'mn-c2', false); // east → south (down)
  c = place(pieces, c, 'straight', { id: 'mn-rdn0' });
  c = place(pieces, c, 'straight', { id: 'mn-rdn1' });
  c = corner(pieces, c, 'mn-c3', true); // south → east
  c = place(pieces, c, 'straight', { id: 'mn-q0' });
  // Attach J2 by its THROUGH (index 1); the placement reads rot 180 so its
  // trunk faces east (return chain) and branch faces up-left (deck arrival).
  place(pieces, c, 'junction', { id: JUNCTION_J2_ID, connectVia: 1 });
}

/**
 * Build the DECK chain (train A's path): from J1's BRANCH endpoint, ramp UP onto
 * the layer-1 deck, run east across it (carrying the upper station) above the
 * main-chain bump, then ramp DOWN and swing onto J2's BRANCH endpoint via two
 * ground approach curves. The deck edges are the layer-1 half of the over/under.
 */
function buildDeckChain(pieces: TrackPiece[]): void {
  let c = endpointCursor(pieces, JUNCTION_J1_ID, 2); // J1 'divert' (branch), heading up-right
  c = place(pieces, c, 'ramp', { id: 'la-rampUp' }); // climb to layer 1
  c = place(pieces, c, 'curve', { id: 'dk-c0', flipped: false }); // level out, heading east on the deck
  c = place(pieces, c, 'station', { id: UPPER_STATION_ID }); // the upper station (layer 1)
  c = place(pieces, c, 'straight', { id: 'la-dk1' });
  c = place(pieces, c, 'straight', { id: 'la-dk2' });
  c = place(pieces, c, 'curve', { id: 'dk-c1', flipped: false }); // start the descent (down-right)
  c = place(pieces, c, 'ramp', { id: 'la-rampDown', connectVia: 1 }); // drop back to ground
  // Two ground approach curves swing the descent onto J2's branch endpoint
  // (the divert merge leg); position-snap (≤30mm) closes the join.
  c = place(pieces, c, 'curve', { id: 'la-app0', flipped: true });
  place(pieces, c, 'curve', { id: 'la-app1', flipped: true });
}

/**
 * Build the RETURN chain (shared ground loop closure): from J1's TRUNK endpoint,
 * a rectangular detour BELOW the layout (carrying ground station A) back up onto
 * J2's TRUNK endpoint. Both trains LEAVE J2 via this trunk side — the passive,
 * switch-free merge.
 */
function buildReturnChain(pieces: TrackPiece[]): void {
  let c = endpointCursor(pieces, JUNCTION_J1_ID, 0); // J1 trunk, heading west
  c = corner(pieces, c, 'rt0', true); // west → south
  c = place(pieces, c, 'straight', { id: 'rt-d0' });
  c = place(pieces, c, 'straight', { id: 'rt-d1' });
  c = corner(pieces, c, 'rt1', true); // south → east
  // Bottom run (with ground station A roughly mid-span).
  for (let i = 0; i < 9; i++) {
    if (i === 4) {
      c = place(pieces, c, 'station', { id: GROUND_STATION_A_ID });
    } else {
      c = place(pieces, c, 'straight', { id: `rt-b${i}` });
    }
  }
  c = corner(pieces, c, 'rt2', true); // east → north
  c = place(pieces, c, 'straight', { id: 'rt-u0' });
  c = place(pieces, c, 'straight', { id: 'rt-u1' });
  corner(pieces, c, 'rt3', true); // north → east, landing on J2's trunk
}

/**
 * Build the full unified flyover demo: one connected theta graph with two
 * junctions, two ground stations, an upper deck station over a ground edge, and
 * a train placed on each ground station (snapped to the marker centre so the sim
 * spawns it there, length-aware).
 */
export function buildBridgeDemo(): BridgeDemo {
  const pieces: TrackPiece[] = [];

  // J1 (diverge): trunk(0) anchors the build heading east. `flipped` sends the
  // branch (divert) up-right so the deck arches above the main loop.
  place(pieces, { x: 300, y: 500, dir: 0, layer: 0 }, 'junction', {
    id: JUNCTION_J1_ID,
    flipped: true,
  });

  buildMainChainAndJ2(pieces);
  buildDeckChain(pieces);
  buildReturnChain(pieces);

  // Trains: snap each onto a ground station marker centre of the loop so the sim
  // spawns it at distance 0 on an outgoing edge. Train A starts on ground station
  // A (its schedule forces it up the divert/deck); train B on ground station B.
  const aStart = pieces.find((p) => p.id === GROUND_STATION_A_ID);
  const bStart = pieces.find((p) => p.id === GROUND_STATION_B_ID);
  if (aStart === undefined || bStart === undefined) {
    throw new Error('buildBridgeDemo: expected both ground stations for train placement');
  }
  const trainA: TrackPiece = {
    id: TRAIN_A_ID,
    type: 'train',
    position: { x: aStart.position.x, y: aStart.position.y },
    rotationDeg: 0,
    tagged: false,
  };
  const trainB: TrackPiece = {
    id: TRAIN_B_ID,
    type: 'train',
    position: { x: bStart.position.x, y: bStart.position.y },
    rotationDeg: 0,
    tagged: false,
  };
  pieces.push(trainA, trainB);

  const liveIds = pieces.map((p) => p.id);

  return {
    pieces,
    trainAId: `T-${TRAIN_A_ID}`,
    trainBId: `T-${TRAIN_B_ID}`,
    liveIds,
    groundStations: [`M-${GROUND_STATION_A_ID}`, `M-${GROUND_STATION_B_ID}`],
    upperStation: `M-${UPPER_STATION_ID}`,
    junctionId: `M-${JUNCTION_J1_ID}`,
  };
}
