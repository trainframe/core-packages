/**
 * A deterministic two-train SINGLE-DIRECTION OVAL with a HUMP FLYOVER, built
 * with a small turtle.
 *
 * The scene is ONE connected oval track (a rounded rectangle) circulated in the
 * SAME direction by both trains. Along the BOTTOM straight the loop is
 * grade-separated:
 *
 *   - B (the ground train) takes the MAIN bypass: a flat ground straight under
 *     the deck, J1.through → ground straight (carrying a bare waypoint) →
 *     J2.through. B never leaves layer 0.
 *   - A (the flyover train) takes the DECK bypass: J1.branch (divert) → ramp UP
 *     onto a layer-1 deck (carrying the UPPER STATION) that runs OVER B's ground
 *     straight → ramp DOWN → J2.branch. A literally rides OVER B, then continues
 *     forward down the far ramp and merges at J2.
 *
 * The rest of the oval — J2.trunk → bottom-right corner → right side → top
 * straight → left side → bottom-left corner → J1.trunk — is SHARED and
 * traversed in the SAME direction by both trains, so ADR-011 block exclusivity
 * gives one-block spacing and never a head-on.
 *
 * Forward cyclic order, identical for both trains:
 *   J1 → { upper deck (A, divert) | main straight (B, main) } → J2
 *      → right corner → right side → top → left side → left corner → J1
 * A throws J1 to 'divert' on its handover and B throws it to 'main' — the
 * per-lap switch flip the demo shows off. J2 is a PASSIVE merge: both trains
 * arrive on a branch/through leg and leave via its switch-free trunk.
 *
 * Pure geometry: no React, no I/O, no clock, no randomness — given no input it
 * always returns the same pieces. The closures (deck→J2.branch, main→J2.through,
 * oval J2.trunk→J1.trunk) are tuned against the compile test
 * (bridge-demo.test.ts) and the strict deterministic harness gate
 * (two-train-flyover.spec.ts in @trainframe/ui-tests).
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

/** Ground station on the SHARED top straight — train A's home (after the deck). */
const GROUND_STATION_A_ID = 'top-stationA';
/** Ground station on the SHARED right side — train B's home. */
const GROUND_STATION_B_ID = 'rt-stationB';
/** Bare waypoint on the MAIN bypass: pins B through the ground straight (off the
 * deck) and forces forward circulation. Not a station. */
const MAIN_WAYPOINT_ID = 'mn-wp';
/** Bare waypoint on the SHARED TOP straight: pins each train's return leg the
 * long way round the oval (same direction as the other), so the shared
 * single-track section never sees a head-on. Not a station. */
const LOOP_WAYPOINT_ID = 'loop-wp';
/** The UPPER station on the layer-1 deck — reachable only over the flyover. */
const UPPER_STATION_ID = 'dk-station';
/** First ground marker A reaches AFTER descending the far ramp and merging at
 * J2 — the "down the far side" discriminator that proves A traversed the whole
 * bridge rather than bouncing back. */
const FAR_RAMP_BASE_ID = 'dk-rampDown';

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
  /** The two ground-station marker ids (`M-{pieceId}`): [groundA, groundB]. */
  readonly groundStations: string[];
  /** The upper-station marker id (`M-{pieceId}`) on the layer-1 deck. */
  readonly upperStation: string;
  /** The bare main-bypass waypoint marker id (`M-{pieceId}`): keeps B grounded. */
  readonly mainWaypoint: string;
  /** The shared-top waypoint marker id (`M-{pieceId}`): direction-pins return legs. */
  readonly loopWaypoint: string;
  /** The DIVERGE junction (J1) marker id (`M-{pieceId}`). */
  readonly junctionId: string;
  /** The MERGE junction (J2) marker id (`M-{pieceId}`). */
  readonly mergeJunctionId: string;
  /** The marker id (`M-{pieceId}`) a train at ground station A should head TO
   * to travel in the circulation direction — the harness's startEdge target. */
  readonly forwardFromGroundA: string;
  /** The marker id (`M-{pieceId}`) a train at ground station B should head TO
   * to travel in the circulation direction — the harness's startEdge target. */
  readonly forwardFromGroundB: string;
  /**
   * The ORDERED layer-1 deck spine marker ids A must traverse IN ORDER on every
   * lap (ramp-up base → upper station → far ramp-down base): the
   * up-over-and-down-the-far-side proof. A bounce omits the tail of this list.
   */
  readonly bridgeSpine: { rampUp: string; upper: string; rampDown: string };
}

/**
 * Build the MAIN bypass (train B's path) and place J2. From J1's THROUGH
 * endpoint a flat ground straight runs east UNDER the deck, carrying the bare
 * waypoint `mn-wp`, and lands on a freshly placed J2 via its THROUGH endpoint.
 * J2 is placed `connectVia: 1` so its TRUNK (index 0) becomes the cursor's exit
 * and faces the oval, and its BRANCH (index 2) faces the deck descent.
 */
function buildMainBypassAndJ2(pieces: TrackPiece[]): void {
  let c = endpointCursor(pieces, JUNCTION_J1_ID, 1); // J1 'main' (through), heading east
  c = place(pieces, c, 'straight', { id: 'mn-s0' });
  c = place(pieces, c, 'straight', { id: MAIN_WAYPOINT_ID }); // bare waypoint, under the deck
  c = place(pieces, c, 'straight', { id: 'mn-s1' });
  c = place(pieces, c, 'straight', { id: 'mn-s2' });
  // Attach J2 by its THROUGH (index 1); the placement reads rot 180 so its
  // trunk faces east (oval). `flipped` mirrors its BRANCH to the SOUTH side of
  // the ground line so the deck must cross the ground centreline diagonally to
  // reach it — that crossing is the genuine over/under.
  place(pieces, c, 'junction', { id: JUNCTION_J2_ID, connectVia: 1, flipped: true });
}

/**
 * Build the DECK bypass (train A's path): from J1's BRANCH endpoint, ramp UP
 * onto the layer-1 deck (heading up-right, north of the ground line), level out
 * east carrying the upper station, run east so the flat deck passes directly
 * OVER the main ground straight (the over/under), then ramp DOWN and swing onto
 * J2's BRANCH endpoint. The deck DIAGONALLY crosses the ground centreline so a
 * layer-1 edge strictly crosses a layer-0 edge in 2D, sharing no marker. The
 * upper station is reachable ONLY through these divert legs.
 */
function buildDeckChain(pieces: TrackPiece[]): void {
  let c = endpointCursor(pieces, JUNCTION_J1_ID, 2); // J1 'divert' (branch), heading NE (315°)
  c = place(pieces, c, 'ramp', { id: 'dk-rampUp' }); // climb to layer 1, still heading NE
  c = place(pieces, c, 'station', { id: UPPER_STATION_ID }); // the upper station (layer 1), heading NE
  c = place(pieces, c, 'curve', { id: 'dk-c0', flipped: false }); // bend toward the descent
  c = place(pieces, c, 'curve', { id: 'dk-c1', flipped: false });
  // The middle deck pieces straddle the ground straight: the layer-1 chain runs
  // from the north side (y<700) to the south side (y>700), so a layer-1 edge
  // strictly crosses the layer-0 ground straight (y=700) in 2D, sharing no
  // marker — the genuine over/under.
  c = place(pieces, c, 'curve', { id: 'dk-c2', flipped: false });
  c = place(pieces, c, 'curve', { id: 'dk-c3', flipped: true });
  // Down-ramp drops back to ground; `connectVia: 1` connects its upper (layer-1)
  // end to the deck and exits at its ground end, which lands on J2's south-facing
  // BRANCH endpoint by symmetry about (900, 700) (position-snap ≤30mm closes it).
  place(pieces, c, 'ramp', { id: FAR_RAMP_BASE_ID, connectVia: 1 });
}

/**
 * Build the SHARED OVAL closure: from J2's TRUNK endpoint, run the bottom-right
 * corner, up the right side (carrying ground station B), across the top
 * (carrying the bare top waypoint and ground station A), down the left side,
 * and the bottom-left corner back onto J1's TRUNK endpoint. Both trains
 * traverse this in the SAME direction, so the merge at J2 is switch-free and
 * the shared section never sees a head-on.
 */
function buildOvalClosure(pieces: TrackPiece[]): void {
  // The shared oval is a rounded rectangle BELOW the bypasses, traversed in the
  // same direction by both trains. From J1's TRUNK (heading west) it drops down
  // the LEFT side (carrying ground station A, near J1 — so A's forward route to
  // the bridge runs the short way down-left through J1, never the long way round
  // through J2), runs the BOTTOM (carrying the bare top waypoint that
  // direction-pins both trains' return legs), climbs the RIGHT side (carrying
  // ground station B, near J2), and closes on J2's TRUNK. Every `corner` is
  // `flipped: true` (turns clockwise: W→S→E→N→E). The straight counts (left 2,
  // bottom 6, right 2) were tuned so the final corner's exit lands EXACTLY on
  // J2's trunk endpoint (the closure search; ≤30mm snap closes the join).
  let c = endpointCursor(pieces, JUNCTION_J1_ID, 0); // J1 trunk, heading west
  c = corner(pieces, c, 'ov-tl', true); // west → south (top-left corner)
  // Left side (heading south) carrying station A near J1.
  c = place(pieces, c, 'station', { id: GROUND_STATION_A_ID });
  c = place(pieces, c, 'straight', { id: 'lt-l0' });
  c = corner(pieces, c, 'ov-bl', true); // south → east (bottom-left corner)
  // Bottom run (heading east) carrying the bare top waypoint mid-span.
  c = place(pieces, c, 'straight', { id: 'bt-b0' });
  c = place(pieces, c, 'straight', { id: 'bt-b1' });
  c = place(pieces, c, 'straight', { id: LOOP_WAYPOINT_ID });
  c = place(pieces, c, 'straight', { id: 'bt-b3' });
  c = place(pieces, c, 'straight', { id: 'bt-b4' });
  c = place(pieces, c, 'straight', { id: 'bt-b5' });
  c = corner(pieces, c, 'ov-br', true); // east → north (bottom-right corner)
  // Right side (heading north) carrying station B near J2.
  c = place(pieces, c, 'straight', { id: 'rt-r0' });
  c = place(pieces, c, 'station', { id: GROUND_STATION_B_ID });
  // Top-right corner: north → east, landing back onto J2's trunk (≤30mm snap).
  corner(pieces, c, 'ov-tr', true);
}

/**
 * Build the full oval flyover demo: one connected graph with two junctions, two
 * ground stations on the shared oval, an upper deck station over the ground
 * straight, and a train placed on each ground station (snapped to the marker
 * centre so the sim spawns it there, length-aware).
 */
export function buildBridgeDemo(): BridgeDemo {
  const pieces: TrackPiece[] = [];

  // J1 (diverge): trunk(0) anchors the build heading east. `flipped` sends the
  // branch (divert) up-right so the deck arches above the ground straight.
  place(pieces, { x: 300, y: 700, dir: 0, layer: 0 }, 'junction', {
    id: JUNCTION_J1_ID,
    flipped: true,
  });

  buildMainBypassAndJ2(pieces);
  buildDeckChain(pieces);
  buildOvalClosure(pieces);

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
    mainWaypoint: `M-${MAIN_WAYPOINT_ID}`,
    loopWaypoint: `M-${LOOP_WAYPOINT_ID}`,
    junctionId: `M-${JUNCTION_J1_ID}`,
    mergeJunctionId: `M-${JUNCTION_J2_ID}`,
    // Forward (circulation-direction) neighbour of each ground station: A (on
    // the left side, near J1) heads toward the top-left corner and J1; B (on the
    // right side, near J2) heads down toward the bottom run. These pin each
    // train's startEdge so it spawns facing forward.
    forwardFromGroundA: 'M-ov-tlb',
    forwardFromGroundB: 'M-rt-r0',
    bridgeSpine: {
      rampUp: 'M-dk-rampUp',
      upper: `M-${UPPER_STATION_ID}`,
      rampDown: `M-${FAR_RAMP_BASE_ID}`,
    },
  };
}
