/**
 * The "interesting" demo layout, assembled from REAL track pieces (`pieces.ts`) —
 * NOT an oval-with-one-layby. Topology (the standing contract):
 *
 *   - ONE main loop,
 *   - a BRANCH off it carrying the RAILYARD (a drive-through fan),
 *   - TWO SATELLITE LOOPS, each diverging off the main loop and rejoining it,
 *   - each satellite carrying its OWN branch to a STATION only some trains target,
 *   - grade separation (height `layer` + ramps) where satellite track crosses the
 *     main loop, so the running lines genuinely overlap without fouling.
 *
 * Built by the `PieceNetworkBuilder` turtle on the Brio/IKEA 45°/200 mm grid, so it
 * closes by construction and an accidental same-layer overlap is a build-time error.
 * This module grows in slices, each verified by closure/overlap tests before the
 * next is hung off it; this first slice is the MAIN LOOP with the three branch
 * junctions (the spine everything else attaches to).
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import type { RailNetwork } from './network.js';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const CURVE: PieceSpec = { type: 'curve' };
const FLIP: PieceSpec = { type: 'curve', flipped: true };

/** A 180° end (a semicircle) = four same-chirality 45° curves. */
const SEMI: readonly PieceSpec[] = [CURVE, CURVE, CURVE, CURVE];

/** A HUMP — curve out and back to the same line + heading (net 0° turn), so a run
 *  winds instead of running dead straight. The reason real layouts read as fun: the
 *  track flows in and out rather than turning only at the corners. */
const HUMP: readonly PieceSpec[] = [CURVE, FLIP, FLIP, CURVE];

/** `n` straights in a row. */
function side(n: number): PieceSpec[] {
  return Array.from({ length: n }, () => STRAIGHT);
}

/** The branch junctions the main loop exposes — each a facing turnout whose THROUGH
 *  continues the main line and whose BRANCH is the stub a later slice grows into the
 *  yard / a satellite loop. */
export interface MainLoopBranches {
  /** Switch id + branch-stub segment + its exit cursor, for each tap. */
  readonly yard: BranchTap;
  readonly satA: BranchTap;
  readonly satB: BranchTap;
}

export interface BranchTap {
  readonly switchId: string;
  /** The facing turnout's through path (main continues) + branch path (the stub). */
  readonly throughSeg: string;
  readonly branchSeg: string;
  /** The cursor at the end of the branch stub — where the next slice continues. */
  readonly branchExit: Cursor;
  /** Switch positions: `main` stays on the loop, `divert` takes the branch. */
  readonly mainPos: string;
  readonly divertPos: string;
}

export interface MainLoopScene {
  readonly net: RailNetwork;
  readonly pieces: ReturnType<PieceNetworkBuilder['build']>['pieces'];
  readonly geom: ReturnType<PieceNetworkBuilder['build']>['geom'];
  readonly branches: MainLoopBranches;
  /** A segment a train can spawn on to lap the main loop. */
  readonly startSegment: string;
  /** End-to-start closure gap (mm). */
  readonly closureGapMm: number;
}

/** Lay a facing turnout into the running line: a one-piece inbound stub from
 *  `cursor` (fed by `prevSeg`), then the turnout — THROUGH continues the main
 *  (returned as the onward cursor), BRANCH taps off a stub. `flipped` selects the
 *  side the branch peels off (which way the yard/satellite hangs). */
function tap(
  b: PieceNetworkBuilder,
  prevSeg: string,
  cursor: Cursor,
  id: string,
  flipped: boolean,
): { onward: Cursor; taps: BranchTap } {
  const switchId = `${id}-SW`;
  const mainPos = 'main';
  const divertPos = 'divert';
  const inbound = `${id}-in`;
  const throughSeg = `${id}-thru`;
  const branchSeg = `${id}-br`;
  const afterIn = b.run(inbound, cursor, [STRAIGHT]);
  b.link(prevSeg, inbound);
  const { thruExit, branchExit } = b.junction(throughSeg, branchSeg, afterIn, flipped);
  b.link(inbound, throughSeg, { switchId, position: mainPos });
  b.link(inbound, branchSeg, { switchId, position: divertPos });
  return {
    onward: thruExit,
    taps: { switchId, throughSeg, branchSeg, branchExit, mainPos, divertPos },
  };
}

/**
 * Build the MAIN LOOP — a WINDING loop of real pieces (humps make the runs flow in and
 * out, not run dead straight) with three facing turnouts tapped into it: one on the
 * bottom run (the YARD branch, below) and two on the top run (the SATELLITE loops,
 * above). Semicircle ends + a filler-sized final run close it; each tap's branch is a
 * short stub a later slice grows out.
 */
export function buildMainLoopScene(): MainLoopScene {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };

  /* BOTTOM run (heading east): winds via a hump, with the YARD tap (branch below).
   *  Humps net 0° so the run returns to the y=0 line, heading east. */
  const startSegment = 'bot-a';
  const afterBotA = b.run(startSegment, start, [STRAIGHT, ...HUMP, STRAIGHT]);
  const yard = tap(b, startSegment, afterBotA, 'yard', false);
  const afterBotB = b.run('bot-b', yard.onward, [STRAIGHT, ...HUMP, STRAIGHT]);
  b.link(yard.taps.throughSeg, 'bot-b');

  /* RIGHT end: a semicircle up to the top run (turns east → west). */
  const afterSemiR = b.run('semi-r', afterBotB, SEMI);
  b.link('bot-b', 'semi-r');

  /* TOP run (heading west): winds via humps, with the TWO satellite taps (branches
   *  above). The taps + humps make it asymmetric to the bottom, so the final segment
   *  is filler-sized to land the left end back above the start x. */
  const afterTopA = b.run('top-a', afterSemiR, [STRAIGHT, ...HUMP]);
  b.link('semi-r', 'top-a');
  const satA = tap(b, 'top-a', afterTopA, 'satA', true);
  const afterTopB = b.run('top-b', satA.onward, [STRAIGHT, ...HUMP]);
  b.link(satA.taps.throughSeg, 'top-b');
  const satB = tap(b, 'top-b', afterTopB, 'satB', true);
  /* Close the top run to x = start.x (heading west, x decreasing). */
  const remaining = satB.onward.x - start.x;
  const full = Math.max(0, Math.floor(remaining / 200 + 1e-6));
  const filler = remaining - full * 200;
  const topCSpecs = side(full);
  if (filler > 0.5) topCSpecs.push({ type: 'straight', lengthMm: filler });
  const afterTopC = b.run('top-c', satB.onward, topCSpecs);
  b.link(satB.taps.throughSeg, 'top-c');

  /* LEFT end: a semicircle back down to the start. */
  const afterSemiL = b.run('semi-l', afterTopC, SEMI);
  b.link('top-c', 'semi-l');
  b.link('semi-l', startSegment); // close the loop

  const closureGapMm = Math.hypot(afterSemiL.x - start.x, afterSemiL.y - start.y);
  const built = b.build();
  return {
    net: built.net,
    pieces: built.pieces,
    geom: built.geom,
    branches: { yard: yard.taps, satA: satA.taps, satB: satB.taps },
    startSegment,
    closureGapMm,
  };
}
