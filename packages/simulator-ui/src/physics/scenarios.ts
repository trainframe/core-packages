/**
 * The seven physics acceptance scenarios (ADR-030). Each stages a small chain of
 * REAL track pieces and some bodies, then a timed script of motion intents — the
 * only thing a loco device ever commands. The physics (collisions, coupling,
 * derail, run-off) is emergent; nothing here is hand-animated.
 *
 * Pure data + a tiny placement turtle, DOM-free. The view (`PhysicsScenarioView`)
 * builds the rail + world from a scenario and renders it; the harness records a
 * video and asserts the resulting body fates.
 */

import {
  type RotationDeg,
  type TrackPiece,
  type TrackPieceType,
  getEndpoints,
} from '../track/pieces.js';
import type { BodyInit, Motion } from './world.js';

interface Cursor {
  readonly x: number;
  readonly y: number;
  readonly dir: number;
}

function toRotationDeg(deg: number): RotationDeg {
  return ((((Math.round(deg / 45) * 45) % 360) + 360) % 360) as RotationDeg;
}

/** Place a piece so its `connectVia` endpoint (default 0) lands on `cursor`;
 *  return the cursor at the OTHER endpoint (or unchanged for a terminal piece).
 *  `connectVia: 1` attaches a ramp by its HIGH end, so the rail then descends —
 *  a down-ramp the physics accelerates a train down. */
function place(
  pieces: TrackPiece[],
  cursor: Cursor,
  type: TrackPieceType,
  id: string,
  opts: { flipped?: boolean; radiusMm?: number; connectVia?: 0 | 1 } = {},
): Cursor {
  const connectVia = opts.connectVia ?? 0;
  const exitVia = connectVia === 0 ? 1 : 0;
  const extras: Pick<TrackPiece, 'flipped' | 'radiusMm'> = {
    ...(opts.flipped === true ? { flipped: true } : {}),
    ...(opts.radiusMm !== undefined ? { radiusMm: opts.radiusMm } : {}),
  };
  const probe: TrackPiece = {
    id: '__p__',
    type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
    ...extras,
  };
  const entry = getEndpoints(probe)[connectVia];
  if (entry === undefined) throw new Error(`place: ${type} has no endpoint ${connectVia}`);
  const rotationDeg = toRotationDeg(cursor.dir + 180 - entry.outgoingAngleDeg);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = entry.x * cos - entry.y * sin;
  const ry = entry.x * sin + entry.y * cos;
  const real: TrackPiece = {
    id,
    type,
    position: { x: cursor.x - rx, y: cursor.y - ry },
    rotationDeg,
    tagged: false,
    ...extras,
  };
  pieces.push(real);
  const exit = getEndpoints(real)[exitVia];
  if (exit === undefined) return cursor; // terminal piece (terminus)
  return { x: exit.x, y: exit.y, dir: exit.outgoingAngleDeg };
}

/** Lay `n` straights east from `cursor`, returning the new cursor. */
function straights(pieces: TrackPiece[], cursor: Cursor, n: number, prefix: string): Cursor {
  let c = cursor;
  for (let i = 0; i < n; i++) c = place(pieces, c, 'straight', `${prefix}${i}`);
  return c;
}

/** A motion-intent change a TrainDevice applies at `atS` (the device's only
 *  command). */
export interface ScriptStep {
  readonly atS: number;
  readonly id: string;
  readonly motion: Motion;
}

/** One independent rail + its bodies (a separate world). Parallel tracks (the
 *  load and ramp demos) are extra tracks the view runs side by side. */
export interface TrackSpec {
  readonly pieces: TrackPiece[];
  readonly bodies: BodyInit[];
  readonly couples?: ReadonlyArray<readonly [string, string]>;
  readonly script?: ReadonlyArray<ScriptStep>;
}

export interface PhysicsScenario {
  readonly name: string;
  readonly title: string;
  readonly pieces: TrackPiece[];
  readonly bodies: BodyInit[];
  /** Pairs to pre-couple at stage time (a seeded rake). */
  readonly couples: ReadonlyArray<readonly [string, string]>;
  /** Timed motion-intent changes (the device's only command). */
  readonly script: ReadonlyArray<ScriptStep>;
  /** Additional independent rails rendered alongside (each its own world) — for
   *  the parallel-track comparison demos (load, ramps). */
  readonly moreTracks?: ReadonlyArray<TrackSpec>;
  readonly durationS: number;
  /** View-box padding (mm) around the pieces — widen it where a body flies off
   *  the rail (derail/run-off) so the excursion stays on camera. */
  readonly viewPad?: number;
  /** When present, the view runs a VisionStation over this footprint + two
   *  markers, firing a crossing when `locoId` passes each marker x, and shows the
   *  measured length. The y is the rail centre-line. */
  readonly vision?: {
    readonly locoId: string;
    readonly railY: number;
    readonly markerAx: number;
    readonly markerBx: number;
    readonly footprintX: number;
    readonly footprintRadiusMm: number;
    /** The rake's true physical span (mm), for the on-screen comparison. */
    readonly rakeSpanMm: number;
  };
}

const RED = '#c0392b';
const BLUE = '#2d6cdf';
const AMBER = '#e08a1e';
const PURPLE = '#8e44ad';
const GREEN = '#27ae60';

const START: Cursor = { x: 200, y: 600, dir: 0 };

function collision(): PhysicsScenario {
  const pieces: TrackPiece[] = [];
  straights(pieces, START, 8, 's'); // 1600 mm of rail
  return {
    name: 'collision',
    title: 'Two trains collide and stop each other (no markers)',
    pieces,
    bodies: [
      { id: 'red', kind: 'loco', railPos: 200, facing: 1, motion: 'forward', color: RED },
      { id: 'blue', kind: 'loco', railPos: 1400, facing: -1, motion: 'forward', color: BLUE },
    ],
    couples: [],
    script: [],
    durationS: 7,
  };
}

function push(): PhysicsScenario {
  const pieces: TrackPiece[] = [];
  straights(pieces, START, 12, 's');
  return {
    name: 'push',
    title: 'A train pushes a loose carriage along',
    pieces,
    bodies: [
      { id: 'red', kind: 'loco', railPos: 200, facing: 1, motion: 'forward', color: RED },
      { id: 'wagon', kind: 'carriage', railPos: 500, facing: 1, color: PURPLE },
    ],
    couples: [],
    // Shove it along, then cut the loco's power: the brakeless wagon keeps its
    // momentum and trundles on, pulling clear of the halted loco.
    script: [{ atS: 4, id: 'red', motion: 'stopped' }],
    durationS: 8,
  };
}

function terminus(): PhysicsScenario {
  const pieces: TrackPiece[] = [];
  const c = straights(pieces, START, 6, 's');
  place(pieces, c, 'terminus', 'buffer');
  return {
    name: 'terminus',
    title: 'A train stops at a buffer — purely in the simulator (no marker, no core)',
    pieces,
    bodies: [{ id: 'red', kind: 'loco', railPos: 150, facing: 1, motion: 'forward', color: RED }],
    couples: [],
    script: [],
    durationS: 7,
  };
}

function couple(): PhysicsScenario {
  const pieces: TrackPiece[] = [];
  straights(pieces, START, 12, 's');
  return {
    name: 'couple',
    title: 'A train reverses onto a carriage and magnetically couples, then pulls away',
    pieces,
    bodies: [
      { id: 'wagon', kind: 'carriage', railPos: 800, facing: 1, color: GREEN },
      { id: 'red', kind: 'loco', railPos: 1200, facing: 1, motion: 'reverse', color: RED },
    ],
    couples: [],
    // back onto the wagon (couples ~1.3s), pull forward, then halt mid-rail.
    script: [
      { atS: 2.5, id: 'red', motion: 'forward' },
      { atS: 5, id: 'red', motion: 'stopped' },
    ],
    durationS: 7,
  };
}

function tugOfWar(): PhysicsScenario {
  const pieces: TrackPiece[] = [];
  straights(pieces, START, 10, 's');
  return {
    name: 'tugofwar',
    title: 'Two opposed trains coupled to one carriage — stalemate at equal power',
    pieces,
    bodies: [
      {
        id: 'red',
        kind: 'loco',
        railPos: 930,
        facing: -1,
        motion: 'forward',
        power: 100,
        color: RED,
      },
      { id: 'wagon', kind: 'carriage', railPos: 1000, facing: 1, color: PURPLE },
      {
        id: 'blue',
        kind: 'loco',
        railPos: 1070,
        facing: 1,
        motion: 'forward',
        power: 100,
        color: BLUE,
      },
    ],
    couples: [
      ['red', 'wagon'],
      ['wagon', 'blue'],
    ],
    script: [],
    durationS: 6,
  };
}

function derail(): PhysicsScenario {
  const pieces: TrackPiece[] = [];
  let c = straights(pieces, START, 3, 's');
  c = place(pieces, c, 'ramp', 'ramp', { connectVia: 1 }); // a DOWN ramp — gravity speeds it up
  c = straights(pieces, c, 1, 'm');
  c = place(pieces, c, 'curve-tight', 'cv0'); // 100 mm radius — too tight at speed
  place(pieces, c, 'curve-tight', 'cv1');
  return {
    name: 'derail',
    title: 'A train going too fast (down the ramp) derails on the tight curve',
    pieces,
    // High-powered loco; the down-ramp adds yet more speed, so it can't hold the curve.
    bodies: [
      {
        id: 'red',
        kind: 'loco',
        railPos: 100,
        facing: 1,
        motion: 'forward',
        power: 3200,
        color: RED,
      },
    ],
    couples: [],
    script: [],
    durationS: 6,
    viewPad: 1000, // the loco flies off the curve tangent — keep it in shot
  };
}

function runoff(): PhysicsScenario {
  const pieces: TrackPiece[] = [];
  straights(pieces, START, 6, 's'); // open end — no buffer
  return {
    name: 'runoff',
    title: 'A train runs off the end of unbuilt track into free space',
    pieces,
    bodies: [{ id: 'red', kind: 'loco', railPos: 150, facing: 1, motion: 'forward', color: RED }],
    couples: [],
    script: [],
    durationS: 6,
  };
}

function vision(): PhysicsScenario {
  const pieces: TrackPiece[] = [];
  straights(pieces, START, 16, 's'); // 3200 mm; rail d=0 at world x=200
  // A loco + two carriages, coupled at 68 mm spacing, drive east past the camera.
  // Rake span = loco half (34) + 2×68 + carriage half (30) = 200 mm.
  return {
    name: 'vision',
    title:
      'Vision station measures a passing train’s length — speed from two markers, no self-report',
    pieces,
    bodies: [
      // Brisk power so the laden rake still clears the camera promptly; the
      // measured length is speed-independent (speed × dwell), so this is fine.
      {
        id: 'red',
        kind: 'loco',
        railPos: 320,
        facing: 1,
        motion: 'forward',
        power: 2400,
        color: RED,
      },
      { id: 'c1', kind: 'carriage', railPos: 252, facing: 1, color: GREEN },
      { id: 'c2', kind: 'carriage', railPos: 184, facing: 1, color: AMBER },
    ],
    couples: [
      ['red', 'c1'],
      ['c1', 'c2'],
    ],
    script: [{ atS: 7, id: 'red', motion: 'stopped' }],
    durationS: 8,
    vision: {
      locoId: 'red',
      railY: START.y,
      markerAx: 800, // railPos 600
      markerBx: 1200, // railPos 1000 — baseline 400 mm
      footprintX: 1900, // well past both markers, so speed is known before the rake clears
      footprintRadiusMm: 12,
      rakeSpanMm: 200,
    },
  };
}

const PALETTE = [RED, BLUE, GREEN, AMBER, PURPLE];

/** One straight track with an identical loco pulling `carriages` wagons, at world
 *  `y`. Identical power across tracks — only the load differs. */
function pullTrack(y: number, carriages: number, idx: number): TrackSpec {
  const pieces: TrackPiece[] = [];
  straights(pieces, { x: 200, y, dir: 0 }, 13, `t${idx}`); // 2600 mm
  const loco = `L${idx}`;
  const color = PALETTE[idx % PALETTE.length] ?? RED;
  const bodies: BodyInit[] = [
    { id: loco, kind: 'loco', railPos: 420, facing: 1, motion: 'forward', color },
  ];
  const couples: [string, string][] = [];
  for (let j = 0; j < carriages; j++) {
    const cid = `L${idx}c${j}`;
    bodies.push({ id: cid, kind: 'carriage', railPos: 420 - (j + 1) * 68, facing: 1, color });
    couples.push([j === 0 ? loco : `L${idx}c${j - 1}`, cid]);
  }
  return { pieces, bodies, couples };
}

function load(): PhysicsScenario {
  // Five identical locos (same power), pulling 1,2,3,4,5 carriages, on parallel
  // tracks. They start together; the lighter trains pull ahead.
  const t0 = pullTrack(280, 1, 0);
  const rest = [470, 660, 850, 1040].map((yPos, i) => pullTrack(yPos, i + 2, i + 1));
  return {
    name: 'load',
    title: 'Five identical locos, each pulling one more carriage — fewer carriages run faster',
    pieces: t0.pieces,
    bodies: t0.bodies,
    couples: t0.couples ?? [],
    script: [],
    moreTracks: rest,
    durationS: 7,
  };
}

/** A flat / uphill / downhill track with one identical loco. `kind` picks the
 *  grade: a chain of straights, up-ramps (slope +1), or down-ramps (slope -1). */
function gradeTrack(y: number, kind: 'flat' | 'up' | 'down', idx: number): TrackSpec {
  const pieces: TrackPiece[] = [];
  const start: Cursor = { x: 200, y, dir: 0 };
  if (kind === 'flat') {
    straights(pieces, start, 20, `g${idx}`);
  } else {
    let c = start;
    for (let i = 0; i < 20; i++) {
      c = place(pieces, c, 'ramp', `g${idx}_${i}`, kind === 'down' ? { connectVia: 1 } : {});
    }
  }
  return {
    pieces,
    bodies: [
      {
        id: kind,
        kind: 'loco',
        railPos: 150,
        facing: 1,
        motion: 'forward',
        color: PALETTE[idx] ?? RED,
      },
    ],
  };
}

function ramps(): PhysicsScenario {
  const flat = gradeTrack(320, 'flat', 0);
  const up = gradeTrack(560, 'up', 1);
  const down = gradeTrack(800, 'down', 2);
  return {
    name: 'ramps',
    title: 'Identical locos on a level, an up-ramp (slower), and a down-ramp (faster)',
    pieces: flat.pieces,
    bodies: flat.bodies,
    couples: [],
    script: [],
    moreTracks: [up, down],
    durationS: 7,
  };
}

const BUILDERS: Record<string, () => PhysicsScenario> = {
  collision,
  push,
  terminus,
  couple,
  tugofwar: tugOfWar,
  derail,
  runoff,
  vision,
  load,
  ramps,
};

export const SCENARIO_NAMES = Object.keys(BUILDERS);

export function buildScenario(name: string): PhysicsScenario | undefined {
  return BUILDERS[name]?.();
}
