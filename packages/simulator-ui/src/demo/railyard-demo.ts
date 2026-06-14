/**
 * The RAILYARD RAILYARD DEMO demo: a large single main loop with the pass-through
 * railyard spliced INLINE into it, plus two further experimental pieces sitting
 * LIVE on the running line — a TURNTABLE (an N-way junction the scheduler throws
 * like a point) and a LIFT-BRIDGE (a clearance gate). FOUR trains circulate, each
 * homed at its OWN station, each calling at the yard so coloured carriages
 * MIGRATE from train to train over the laps — the thing the demo exists to show.
 *
 * ── Why four trains circulate without deadlock ──────────────────────────────
 * Trains rely on the scheduler's section-exclusivity (one-block separation) to
 * space themselves; the planner is purely structural and does NOT route around
 * occupied blocks, so a deadlock-free demo needs ROOM and must avoid trains
 * fouling each other at a shared bottleneck:
 *   - The yard sits INLINE on the main loop, NOT hung off it as a diverge/merge
 *     branch. Its throat (`M-yard`) is a marker ON the ring, and the yard is a
 *     ZONE: a train routed to the throat is SUSPENDED there holding no block
 *     (ADR-027), so a queue of trains waiting their turn at the yard never
 *     deadlocks the line. This is EXACTLY the topology `railyard-swap-concurrent`
 *     proves safe under concurrent trains — an in-line zone, no branch to foul.
 *     (The old branch-hung yard, reached through two junctions, was the deadlock
 *     source: a re-merging train, plus a rake trailing back over a junction,
 *     jammed the throat. Splicing the yard in-line removes the branch entirely.)
 *   - The loop is ENLARGED — long straight runs between every feature, so the
 *     four trains keep one clear block between them and a parked rake never
 *     trails back into the next train's path.
 *   - The four trains' yard visits are STAGGERED: each inserts its yard call at a
 *     DIFFERENT point in its stop cycle, so they reach the single-marker throat
 *     spread out in time rather than all converging at once.
 *   - The turntable and lift-bridge are also INLINE (not on dead-end branches),
 *     so every lap traverses them without creating a foul-prone spur.
 *
 * Topology (built with the same turtle as `bridge-demo`, pure geometry):
 *   - A large rectangular main loop, generously blocked, that CLOSES exactly
 *     (the turtle returns to its start within < 1 mm — solved counts below).
 *   - Bottom run: straights … the inline RAILYARD … straights.
 *   - Right run: stn-amber … run … the inline LIFT-BRIDGE … run … stn-blue.
 *   - Top run: run … the inline TURNTABLE (trunk in → east stub out) … run.
 *   - Left run: stn-red … run … stn-green, spread for separation.
 *
 * Each train's rake is placed within coupling distance behind it and the spares
 * by the yard, so ToyHardware.reseedConsists seeds them deterministically from
 * these static positions at stage time. The carriage-swap, the ADR-027 handoff,
 * and concurrent trains queueing through the single-marker zone without deadlock
 * are proven in `packages/integration` (railyard-swap-loop, -concurrent, and
 * railyard-demo-4train — the four-train deadlock-free + migration + traversal
 * proof on THIS compiled layout). Geometry validated by `railyard-demo.test.ts`.
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
// Turtle (a trimmed copy of bridge-demo's — places straights, curves, stations
// and the inline device pieces along a continuous rail, returning the cursor at
// each piece's far endpoint).
// ---------------------------------------------------------------------------

interface Cursor {
  readonly x: number;
  readonly y: number;
  readonly dir: number;
}

function toRotationDeg(deg: number): RotationDeg {
  return ((((Math.round(deg / 45) * 45) % 360) + 360) % 360) as RotationDeg;
}

/** Place a track piece so its FIRST endpoint lands on `cursor`, rail continuing,
 *  and return the new cursor at the OTHER endpoint's world pose. */
function place(pieces: TrackPiece[], cursor: Cursor, type: TrackPieceType, id: string): Cursor {
  const probe: TrackPiece = {
    id: '__probe__',
    type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
  };
  const connectLocal = getEndpoints(probe)[0];
  if (connectLocal === undefined) throw new Error(`place: ${type} has no endpoint 0`);
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
  };
  pieces.push(real);
  const exit = getEndpoints(real)[1];
  if (exit === undefined) throw new Error(`place: ${type} has no exit endpoint`);
  return { x: exit.x, y: exit.y, dir: exit.outgoingAngleDeg };
}

/** Place `n` straights in a row. */
function straights(pieces: TrackPiece[], cursor: Cursor, n: number, idPrefix: string): Cursor {
  let c = cursor;
  for (let i = 0; i < n; i++) c = place(pieces, c, 'straight', `${idPrefix}${i}`);
  return c;
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
const TURNTABLE_ID = 'turntable';
const LIFT_BRIDGE_ID = 'lift-bridge';

/**
 * Straight counts that close the rectangular loop EXACTLY (verified: the turtle
 * returns to its start within < 1 mm) while giving every run generous block
 * separation — a parked rake never trails back into the next train's path, one
 * of the fixes that breaks the old four-train deadlock. Do not retune one
 * without re-solving the loop (bottom span == top span, right span == left span;
 * the 1200 mm inline yard and the 200 mm turntable/lift-bridge each occupy their
 * run like the pieces around them).
 */
const BOTTOM_WEST = 3;
const BOTTOM_EAST = 3;
const RIGHT_TO_BRIDGE = 3;
const BRIDGE_TO_BLUE = 3;
const BLUE_TO_TOP = 2;
const TOP_WEST = 6;
const TOP_EAST = 5;
const TOP_TO_RED = 3;
const RED_TO_GREEN = 3;
const GREEN_TO_BOTTOM = 3;

/**
 * A train's livery and its CYCLIC schedule, in forward (build) order. `stops[0]`
 * is the home station; every train calls at the yard. Forward ordering seeds the
 * initial heading; the directional planner keeps it one-way.
 *
 * The four stops cycle each train the SAME way round the loop (the order the four
 * homes appear going one way — amber → blue → red → green), with the yard call
 * STAGGERED across the cycle so the four don't all converge on the single-marker
 * throat at once. Two trains homed on OPPOSITE sides of the loop (amber, green)
 * call the yard FIRST: being half a loop apart they reach the throat well spaced
 * in time, so a wagon migrates train → train early; the other two (blue, red)
 * call it later in their cycles, spreading the load further.
 */
interface TrainSpec {
  readonly id: string;
  readonly color: string;
  readonly stops: readonly string[];
}

const ALL_TRAIN_SPECS: readonly TrainSpec[] = [
  {
    id: 'amber',
    color: 'amber',
    stops: ['stn-amber', YARD_ID, 'stn-blue', 'stn-red', 'stn-green'],
  },
  {
    id: 'blue',
    color: 'blue',
    stops: ['stn-blue', 'stn-red', YARD_ID, 'stn-green', 'stn-amber'],
  },
  {
    id: 'red',
    color: 'red',
    stops: ['stn-red', 'stn-green', 'stn-amber', YARD_ID, 'stn-blue'],
  },
  {
    id: 'green',
    color: 'green',
    stops: ['stn-green', YARD_ID, 'stn-amber', 'stn-blue', 'stn-red'],
  },
];

/** How many trains circulate (one per home station). FOUR trains on the enlarged
 *  loop with the in-line yard and staggered yard visits circulate deadlock-free —
 *  proven headlessly by `packages/integration/src/railyard-demo-4train.test.ts`. */
const ACTIVE_TRAINS = 4;
const TRAIN_SPECS: readonly TrainSpec[] = ALL_TRAIN_SPECS.slice(0, ACTIVE_TRAINS);

/** Wagons per rake. Three (swap a leading pair, keep one) — short enough to sit
 *  clear between trains, long enough to show migration with a kept car. */
const RAKE_SIZE = 3;

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
  /** The yard's zone marker (`M-{yardPieceId}`) — its throat, in-line on the loop. */
  readonly yardMarker: string;
  readonly yardDeviceId: string;
  /** The switch device ids (`SWITCH-{pieceId}`) the scheduler throws — the inline
   *  turntable (a junction with three positions). */
  readonly switchDeviceIds: string[];
  /** The lift-bridge's clearance-gate device id (`BRIDGE-{pieceId}`). */
  readonly liftBridgeDeviceId: string;
  /** The lift-bridge's marker (`M-{pieceId}`) — an inline block boundary. */
  readonly liftBridgeMarker: string;
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
 * it from geometry: of the station's loop neighbours, pick the one whose travel
 * direction gives the same rotational sense for every train. Both sides drive
 * one way.
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
  const consist = rake(spec.color, RAKE_SIZE);
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
  const ring = layout.markers.filter((m) => m.position !== undefined);
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
 * Build the railyard demo: a single closed main loop with the railyard, a
 * turntable, and a lift-bridge all spliced in-line, plus four home stations.
 * Pure geometry — given no input it always returns the same pieces.
 */
export function buildRailyardDemo(): RailyardDemo {
  const pieces: TrackPiece[] = [];

  // Main loop, starting at the bottom-left heading EAST.
  const start: Cursor = { x: 200, y: 1500, dir: 0 };
  let c: Cursor = start;
  // Bottom run: straights … the inline RAILYARD (its throat marker M-yard is ON
  // the running line — a zone, not a branch) … straights.
  c = straights(pieces, c, BOTTOM_WEST, 'mb');
  c = place(pieces, c, 'railyard', YARD_ID);
  c = straights(pieces, c, BOTTOM_EAST, 'mc');
  c = corner(pieces, c, 'cBR'); // → heading north up the right side

  // Right run: stn-amber, a run, the inline LIFT-BRIDGE, a run, stn-blue.
  c = place(pieces, c, 'station', 'stn-amber');
  c = straights(pieces, c, RIGHT_TO_BRIDGE, 'r0');
  c = place(pieces, c, 'lift-bridge', LIFT_BRIDGE_ID);
  c = straights(pieces, c, BRIDGE_TO_BLUE, 'r1');
  c = place(pieces, c, 'station', 'stn-blue');
  c = straights(pieces, c, BLUE_TO_TOP, 'tr');
  c = corner(pieces, c, 'cTR'); // → heading west across the top

  // Top run: a run, the inline TURNTABLE (trunk in → east stub out; the scheduler
  // throws it to 'stub-a' as a circulating train routes trunk → stub), a run.
  c = straights(pieces, c, TOP_WEST, 't0');
  c = place(pieces, c, 'turntable', TURNTABLE_ID);
  c = straights(pieces, c, TOP_EAST, 't1');
  c = corner(pieces, c, 'cTL'); // → heading south down the left side

  // Left run: stn-red, a run, stn-green, a run, close onto the start.
  c = straights(pieces, c, TOP_TO_RED, 'tl');
  c = place(pieces, c, 'station', 'stn-red');
  c = straights(pieces, c, RED_TO_GREEN, 'l0');
  c = place(pieces, c, 'station', 'stn-green');
  c = straights(pieces, c, GREEN_TO_BOTTOM, 'l1');
  corner(pieces, c, 'cBL'); // → closes onto the start

  // Trains: one per spec, homed on its station, all placed facing the SAME way
  // round the loop (computed from the geometry).
  const trains = placeAllTrains(pieces);

  // Two purple spares parked at the yard centre — claimed by no train, so
  // reseedConsists makes them the yard's spare cut (what the first train leaves
  // wearing).
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
    switchDeviceIds: [`SWITCH-${TURNTABLE_ID}`],
    liftBridgeDeviceId: `BRIDGE-${LIFT_BRIDGE_ID}`,
    liftBridgeMarker: `M-${LIFT_BRIDGE_ID}`,
    yardSpares,
    trains,
  };
}
