/**
 * The RAILYARD SPECTACLE demo: a main loop with the pass-through railyard hung
 * OFF it as a branch (not on the main path), reached through two junctions —
 * J1 (diverge) and J2 (merge). Four trains circulate, each homed at its OWN
 * station, and each calls at the yard every lap. The yard swaps an incoming
 * train's leading pair for its spares, so coloured carriages MIGRATE from train
 * to train over the laps — the thing the demo exists to show.
 *
 * Topology (built with the same turtle as `bridge-demo`, pure geometry):
 *   - A rectangular main loop. Its bottom run carries J1 … straights … J2; the
 *     straights between them are the through "main" path the yard hangs below.
 *   - The yard is a BYPASS branch: J1.branch → level curve → yard → climb curve
 *     → J2.branch. It is reachable ONLY through the junctions, so a schedule that
 *     calls at the yard forces the scheduler to throw J1 to divert (the bridge-
 *     demo mechanism). The branch lands on J2.branch within the 30 mm snap.
 *   - Four station pieces, two on each vertical side (every train traverses both
 *     sides each lap), give each train a distinct home/stop. Two per side keeps
 *     the 200 mm grid balanced so the loop still closes.
 *
 * Each train's rake is placed within coupling distance behind it and the spares
 * by the yard, so ToyHardware.reseedConsists seeds them deterministically from
 * these static positions at stage time. The carriage-swap, the ADR-027 handoff,
 * and concurrent trains queueing through the single-marker zone without deadlock
 * are proven in `packages/integration` (railyard-swap-loop + -concurrent); this
 * module is the live, watchable staging of it. Geometry validated by
 * `railyard-demo.test.ts` (closes, no overlaps, all stations + yard reachable).
 */

import { compileLayout } from '../track/layout-from-pieces.js';
import {
  type CarriageColorId,
  type RotationDeg,
  type TrackPiece,
  type TrackPieceType,
  getEndpoints,
} from '../track/pieces.js';

type CompiledLayout = ReturnType<typeof compileLayout>;

// ---------------------------------------------------------------------------
// Turtle (a trimmed copy of bridge-demo's — adds flipped + connectVia so it can
// place reversed/branch-side junctions, plus an endpoint reader for the branch)
// ---------------------------------------------------------------------------

interface Cursor {
  readonly x: number;
  readonly y: number;
  readonly dir: number;
}

interface PlaceOpts {
  readonly flipped?: boolean;
  /** Which local endpoint connects to the cursor (default 0); the other exits.
   *  `connectVia: 1` attaches a junction by its through end so its trunk becomes
   *  the exit — used to place the MERGE junction reversed. */
  readonly connectVia?: 0 | 1;
  /** Curve radius override (mm). The top station-branch legs use a non-default
   *  radius to land the 220 mm station back on its junction within snap. */
  readonly radiusMm?: number;
}

const extrasOf = (opts: PlaceOpts): Pick<TrackPiece, 'flipped' | 'radiusMm'> => ({
  ...(opts.flipped === true ? { flipped: true } : {}),
  ...(opts.radiusMm !== undefined ? { radiusMm: opts.radiusMm } : {}),
});

function toRotationDeg(deg: number): RotationDeg {
  return ((((Math.round(deg / 45) * 45) % 360) + 360) % 360) as RotationDeg;
}

/** Place a track piece so its `connectVia` endpoint lands on `cursor`, rail
 *  continuing, and return the new cursor at the OTHER endpoint's world pose. */
function place(
  pieces: TrackPiece[],
  cursor: Cursor,
  type: TrackPieceType,
  id: string,
  opts: PlaceOpts = {},
): Cursor {
  const connectVia = opts.connectVia ?? 0;
  const exitVia = connectVia === 0 ? 1 : 0;
  const extras = extrasOf(opts);
  const probe: TrackPiece = {
    id: '__probe__',
    type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
    ...extras,
  };
  const connectLocal = getEndpoints(probe)[connectVia];
  if (connectLocal === undefined) throw new Error(`place: ${type} has no endpoint ${connectVia}`);
  const rotationDeg = toRotationDeg(cursor.dir + 180 - connectLocal.outgoingAngleDeg);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedX = connectLocal.x * cos - connectLocal.y * sin;
  const rotatedY = connectLocal.x * sin + connectLocal.y * cos;
  const real: TrackPiece = {
    id,
    type,
    position: { x: cursor.x - rotatedX, y: cursor.y - rotatedY },
    rotationDeg,
    tagged: false,
    ...extras,
  };
  pieces.push(real);
  const exit = getEndpoints(real)[exitVia];
  if (exit === undefined) throw new Error(`place: ${type} has no exit endpoint`);
  return { x: exit.x, y: exit.y, dir: exit.outgoingAngleDeg };
}

/** Read endpoint `n` of an already-placed piece as a fresh cursor (used to seed
 *  the yard bypass from a junction's branch endpoint). */
function endpointCursor(pieces: ReadonlyArray<TrackPiece>, id: string, n: number): Cursor {
  const piece = pieces.find((p) => p.id === id);
  if (piece === undefined) throw new Error(`endpointCursor: no piece ${id}`);
  const ep = getEndpoints(piece)[n];
  if (ep === undefined) throw new Error(`endpointCursor: piece ${id} has no endpoint ${n}`);
  return { x: ep.x, y: ep.y, dir: ep.outgoingAngleDeg };
}

/** Two same-chirality 45° curves = a 90° corner. */
function corner(pieces: TrackPiece[], cursor: Cursor, idPrefix: string): Cursor {
  let c = place(pieces, cursor, 'curve', `${idPrefix}a`);
  c = place(pieces, c, 'curve', `${idPrefix}b`);
  return c;
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

const YARD_ID = 'yard';
/** Straights between J1 and J2 on the bottom (sets the yard branch spread). */
const MAIN_STRAIGHTS = 6;
/** Straights between each TOP junction pair (J3/J4 and J5/J6) — the two station
 *  branch loops' spread. Two pairs back-to-back = the 8-unit top run. */
const TOP_BRANCH_MID = 2;
/** A 45° descent/ascent straight on each side of the yard, so it drops far
 *  enough below the bottom run that its tall gantry clears the track. */
const YARD_DESCENT = 1;
/** Yard bypass leg curve radius (mm) — lands the 600 mm yard on J2 within snap. */
const YARD_LEG_RADIUS = 265;
/** Station-branch leg curve radius (mm) — lands the 220 mm station on its merge
 *  junction within snap (the station is off the 200 mm grid). */
const BRANCH_LEG_RADIUS = 170;
/** The two branch-loop stations — stops only some trains call at. */
const BRANCH_A_ID = 'stn-A';
const BRANCH_B_ID = 'stn-B';

/**
 * A train's livery and its CYCLIC schedule, in forward (build) order. `stops[0]`
 * is the home station; every train calls at the yard. Forward ordering seeds the
 * initial heading; the directional planner keeps it one-way.
 *
 * TEMPORARY SCALE-BACK. With trains now occupying their true loco+rake length
 * (ADR-029 §0, so they no longer drive through each other), this point-train-
 * sized layout is too tight for the original four-trains-via-branches spectacle:
 * a full rake parked at a branch station trails back across the junction and
 * fouls the main line, and four long trains jam at the single yard-entry
 * junction. So the active schedules are main-line + yard only (no branch
 * dwells), which circulates cleanly. The branch journeys (and the fourth train)
 * are kept here, INACTIVE, and come back once the layout is enlarged (longer
 * runs/branches, more room at the throat) — see ADR-029's "enlarge the layout".
 */
interface TrainSpec {
  readonly id: string;
  readonly color: string;
  readonly stops: readonly string[];
}

const ALL_TRAIN_SPECS: readonly TrainSpec[] = [
  // Stops in CCW CIRCULATION ORDER (amber → yard → blue → red → green → …, the
  // order computed from the loop geometry), each train starting at its home.
  // Every leg is therefore a SHORT FORWARD hop, so the planner never routes a
  // train the short way backwards and the yard visit (a forward stop on the
  // bottom run) never reverses a train's loop direction. Trains placed all one
  // way (circulationFacingDeg) + stops ordered = a valid one-way scenario.
  {
    id: 'amber',
    color: 'amber',
    stops: ['stn-amber', YARD_ID, 'stn-blue', 'stn-red', 'stn-green'],
  },
  {
    id: 'green',
    color: 'green',
    stops: ['stn-green', 'stn-amber', YARD_ID, 'stn-blue', 'stn-red'],
  },
  { id: 'red', color: 'red', stops: ['stn-red', 'stn-green', 'stn-amber', YARD_ID, 'stn-blue'] },
  { id: 'blue', color: 'blue', stops: ['stn-blue', 'stn-red', 'stn-green', 'stn-amber', YARD_ID] },
];

/** How many trains circulate (one per home station). Three full-rake trains on
 *  main-line + yard schedules circulate this layout without deadlock; four (or
 *  any branch dwell) does not, until the layout is enlarged. */
const ACTIVE_TRAINS = 1;
const TRAIN_SPECS: readonly TrainSpec[] = ALL_TRAIN_SPECS.slice(0, ACTIVE_TRAINS);

export interface DemoCarriage {
  readonly id: string;
  readonly colorId: string;
}

export interface DemoTrain {
  /** Wire device id (`T-{pieceId}`). */
  readonly deviceId: string;
  /** The marker (`M-{pieceId}`) the train sits on — schedule `stops[0]`. */
  readonly homeMarker: string;
  /** The cyclic schedule: home station → yard throat, looping (ADR-028 resume). */
  readonly stops: string[];
  /** The rake to seed (ids match live carriage pieces). */
  readonly consist: DemoCarriage[];
}

export interface RailyardDemo {
  readonly pieces: TrackPiece[];
  /** Every piece id that should go live (all track + yard + trains + carriages). */
  readonly liveIds: string[];
  /** The yard's zone marker (`M-{yardPieceId}`) — its throat. */
  readonly yardMarker: string;
  readonly yardDeviceId: string;
  /** The junction switch device ids (`SWITCH-{pieceId}`) the scheduler throws. */
  readonly switchDeviceIds: string[];
  /** Spare wagons to seed into the yard via `loadSpares`. */
  readonly yardSpares: DemoCarriage[];
  readonly trains: DemoTrain[];
}

const rake = (color: string, n: number): DemoCarriage[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${color}${i + 1}`, colorId: color }));

/**
 * The heading (deg) a train homed at `homeId` must face to circulate the SAME
 * way round the loop as every other train. The operator's job is to place trains
 * consistently (an opposed train is a real operator error the scheduler rightly
 * deadlocks); the station PIECE's own rotation does NOT encode a consistent
 * travel direction (corners/flips turn the piece, not the line), so we compute
 * it from geometry: of the station's two loop neighbours, pick the one whose
 * travel direction gives the same rotational sense (negative radius × travel)
 * for every train. Both sides of the loop then drive one way.
 */
function circulationFacingDeg(
  homeId: string,
  layout: CompiledLayout,
  centre: { x: number; y: number },
): RotationDeg {
  const byId = new Map(layout.markers.map((m) => [m.id, m] as const));
  const home = byId.get(`M-${homeId}`)?.position;
  if (home === undefined) return 0;
  let bestDeg: RotationDeg = 0;
  let bestCross = Number.POSITIVE_INFINITY;
  for (const e of layout.edges) {
    if (e.from_marker_id !== `M-${homeId}`) continue;
    const to = byId.get(e.to_marker_id)?.position;
    if (to === undefined) continue;
    const dx = to.x_mm - home.x_mm;
    const dy = to.y_mm - home.y_mm;
    const cross = (home.x_mm - centre.x) * dy - (home.y_mm - centre.y) * dx;
    if (cross < bestCross) {
      bestCross = cross;
      bestDeg = toRotationDeg((Math.atan2(dy, dx) * 180) / Math.PI);
    }
  }
  return bestDeg;
}

/** A train on its home station facing `facingDeg` (its consistent circulation
 *  direction), with its rake parked just behind it along the rail (within
 *  coupling distance so reseedConsists couples them in order). */
function placeTrainWithRake(
  pieces: TrackPiece[],
  spec: TrainSpec,
  home: TrackPiece,
  facingDeg: RotationDeg,
): DemoTrain {
  const consist = rake(spec.color, 4);
  pieces.push({
    id: spec.id,
    type: 'train',
    position: { x: home.position.x, y: home.position.y },
    rotationDeg: facingDeg,
    tagged: false,
  });
  // Behind = opposite the train's heading, so the rake lays along the rail.
  const rad = (facingDeg * Math.PI) / 180;
  const bx = -Math.cos(rad);
  const by = -Math.sin(rad);
  for (let i = 0; i < consist.length; i++) {
    const c = consist[i];
    if (c === undefined) continue;
    const d = (i + 1) * 55;
    pieces.push({
      id: c.id,
      type: 'carriage',
      position: { x: home.position.x + bx * d, y: home.position.y + by * d },
      rotationDeg: facingDeg,
      tagged: false,
      colorId: c.colorId as CarriageColorId,
    });
  }
  return {
    deviceId: `T-${spec.id}`,
    homeMarker: `M-${spec.stops[0]}`,
    stops: spec.stops.map((s) => `M-${s}`),
    consist,
  };
}

/** Place every active train (loco + rake) on its home station, each oriented to
 *  the same circulation sense (computed from the loop geometry). */
function placeAllTrains(pieces: TrackPiece[]): DemoTrain[] {
  const layout = compileLayout(pieces, 'railyard-demo-orient');
  const ring = layout.markers.filter(
    (m) => m.position !== undefined && !/yard|by-|stn-A|stn-B/.test(m.id),
  );
  const centre = {
    x: ring.reduce((s, m) => s + (m.position?.x_mm ?? 0), 0) / ring.length,
    y: ring.reduce((s, m) => s + (m.position?.y_mm ?? 0), 0) / ring.length,
  };
  const trains: DemoTrain[] = [];
  for (const spec of TRAIN_SPECS) {
    const homeId = spec.stops[0];
    const home = homeId === undefined ? undefined : pieces.find((p) => p.id === homeId);
    if (homeId === undefined || home === undefined) {
      throw new Error(`buildRailyardDemo: no station ${homeId}`);
    }
    trains.push(
      placeTrainWithRake(pieces, spec, home, circulationFacingDeg(homeId, layout, centre)),
    );
  }
  return trains;
}

/**
 * Build the railyard demo: a closed main loop with two junctions and the yard
 * hung off it as a bypass branch. Pure geometry — given no input it always
 * returns the same pieces.
 */
export function buildRailyardDemo(): RailyardDemo {
  const pieces: TrackPiece[] = [];

  // Main loop, starting at the bottom-left heading EAST so the BOTTOM junctions'
  // branch legs fall BELOW the loop (the yard) and the TOP junctions' legs rise
  // ABOVE it (the two station branches).
  const start: Cursor = { x: 200, y: 1100, dir: 0 };
  let c: Cursor = start;
  // Bottom: J1 (diverge) … straights … J2 (merge, attached by its through end +
  // flipped so its branch faces back toward the climbing yard bypass).
  c = place(pieces, c, 'junction', 'J1');
  for (let i = 0; i < MAIN_STRAIGHTS; i++) c = place(pieces, c, 'straight', `mb${i}`);
  c = place(pieces, c, 'junction', 'J2', { flipped: true, connectVia: 1 });
  c = corner(pieces, c, 'cBR'); // → heading north up the right side
  c = place(pieces, c, 'station', 'stn-amber');
  c = place(pieces, c, 'station', 'stn-green');
  c = place(pieces, c, 'straight', 'r0');
  c = corner(pieces, c, 'cTR'); // → heading west across the top
  // Top: two branch junction pairs back-to-back — J3/J4 (branch A) then J5/J6
  // (branch B). Together they span the 8-unit top run, matching the bottom.
  c = place(pieces, c, 'junction', 'J3');
  for (let i = 0; i < TOP_BRANCH_MID; i++) c = place(pieces, c, 'straight', `m3${i}`);
  c = place(pieces, c, 'junction', 'J4', { flipped: true, connectVia: 1 });
  c = place(pieces, c, 'junction', 'J5');
  for (let i = 0; i < TOP_BRANCH_MID; i++) c = place(pieces, c, 'straight', `m5${i}`);
  c = place(pieces, c, 'junction', 'J6', { flipped: true, connectVia: 1 });
  c = corner(pieces, c, 'cTL'); // → heading south down the left side
  c = place(pieces, c, 'station', 'stn-red');
  c = place(pieces, c, 'station', 'stn-blue');
  c = place(pieces, c, 'straight', 'l0');
  corner(pieces, c, 'cBL'); // → closes onto the start at J1's trunk

  // Yard bypass (below): J1.branch → 45° descent → level curve → yard → climb
  // curve → 45° ascent → J2.branch. The descent drops the yard far enough that
  // its tall gantry clears the bottom run; the 265 mm legs land it on J2 cleanly.
  let b = endpointCursor(pieces, 'J1', 2);
  for (let i = 0; i < YARD_DESCENT; i++) b = place(pieces, b, 'straight', `by-d${i}`);
  b = place(pieces, b, 'curve', 'by-level', { flipped: true, radiusMm: YARD_LEG_RADIUS });
  b = place(pieces, b, 'railyard', YARD_ID);
  b = place(pieces, b, 'curve', 'by-climb', { flipped: true, radiusMm: YARD_LEG_RADIUS });
  for (let i = 0; i < YARD_DESCENT; i++) b = place(pieces, b, 'straight', `by-a${i}`);

  // Two station branches (above): each J?.branch → curve → station → curve →
  // J?.branch. The 170 mm leg radius lands the 220 mm station within snap.
  for (const [div, stn, mrg] of [
    ['J3', BRANCH_A_ID, 'J4'],
    ['J5', BRANCH_B_ID, 'J6'],
  ] as const) {
    let t = endpointCursor(pieces, div, 2);
    t = place(pieces, t, 'curve', `${stn}-l`, { flipped: true, radiusMm: BRANCH_LEG_RADIUS });
    t = place(pieces, t, 'station', stn);
    place(pieces, t, 'curve', `${stn}-c`, { flipped: true, radiusMm: BRANCH_LEG_RADIUS });
    void mrg;
  }

  // Trains: one per spec, homed on its station, all placed facing the SAME way
  // round the loop (computed from the geometry).
  const trains = placeAllTrains(pieces);

  // Two purple spares parked at the yard centre — claimed by no train, so
  // reseedConsists makes them the yard's spare cut (what the first train leaves
  // wearing). The yard sits well below the loop, far from any train.
  const yardSpares = rake('purple', 2);
  const yard = pieces.find((p) => p.id === YARD_ID);
  if (yard === undefined) throw new Error('buildRailyardDemo: yard piece missing');
  for (let i = 0; i < yardSpares.length; i++) {
    const s = yardSpares[i];
    if (s === undefined) continue;
    pieces.push({
      id: s.id,
      type: 'carriage',
      position: { x: yard.position.x + (i - 0.5) * 64, y: yard.position.y },
      rotationDeg: yard.rotationDeg,
      tagged: false,
      colorId: s.colorId as CarriageColorId,
    });
  }

  const liveIds = pieces.map((p) => p.id);

  return {
    pieces,
    liveIds,
    yardMarker: `M-${YARD_ID}`,
    yardDeviceId: `YARD-${YARD_ID}`,
    switchDeviceIds: ['SWITCH-J1', 'SWITCH-J2', 'SWITCH-J3', 'SWITCH-J4', 'SWITCH-J5', 'SWITCH-J6'],
    yardSpares,
    trains,
  };
}
