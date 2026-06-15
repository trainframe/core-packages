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
import { type CrossoverLoopSegments, addCrossoverLoop } from './crossover-loop.js';
import type { RailNetwork } from './network.js';
import { type ParallelogramYardSegments, addParallelogramYard } from './parallelogram-yard.js';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';
import { type SatelliteLoopSegments, addSatelliteLoop } from './satellite-loop.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const CURVE: PieceSpec = { type: 'curve' };
const FLIP: PieceSpec = { type: 'curve', flipped: true };

/** A 180° end (a semicircle) = four same-chirality 45° curves. */
const SEMI: readonly PieceSpec[] = [CURVE, CURVE, CURVE, CURVE];

/** HUMPS of three sizes — curve out and back to the same line + heading (net 0°), so
 *  a run winds instead of running dead straight. Mixing the sizes keeps the winding
 *  IRREGULAR (a real layout flows in and out by different amounts, not a stamped
 *  pattern). The straights deepen the dip; the curves are the same R200. */
const HUMP_SM: readonly PieceSpec[] = [CURVE, FLIP, FLIP, CURVE];
const HUMP: readonly PieceSpec[] = [CURVE, STRAIGHT, FLIP, FLIP, STRAIGHT, CURVE];
const HUMP_BIG: readonly PieceSpec[] = [
  CURVE,
  STRAIGHT,
  STRAIGHT,
  FLIP,
  FLIP,
  STRAIGHT,
  STRAIGHT,
  CURVE,
];

/** `n` straights in a row. */
function side(n: number): PieceSpec[] {
  return Array.from({ length: n }, () => STRAIGHT);
}

/** How far a spec sequence advances along the travel direction (mm), measured on a
 *  throwaway builder — so the bottom can lay VARIED humps without overshooting. */
function travel(specs: readonly PieceSpec[]): number {
  const tb = new PieceNetworkBuilder();
  const exit = tb.run('probe', { x: 0, y: 0, dir: 0, layer: 0 }, specs);
  return Math.hypot(exit.x, exit.y);
}

/** The branch junctions the main loop exposes — each a facing turnout whose THROUGH
 *  continues the main line and whose BRANCH is the stub a later slice grows into the
 *  yard / a satellite loop. */
export interface MainLoopBranches {
  /** The yard's facing-turnout tap (a dead-end branch stub the trapezoid yard grows
   *  out of). */
  readonly yard: BranchTap;
  /** The satellite LOOP spliced into the top run (divert → big loop → rejoin). */
  readonly satA: SatelliteLoopSegments;
  /** The CROSSOVER loop — a teardrop that bridges over itself once (divert → loop
   *  that crosses over its own track on a height layer → rejoin). */
  readonly satB: CrossoverLoopSegments;
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
  /** The parallelogram yard hanging off the bottom-left tap. */
  readonly yard: ParallelogramYardSegments;
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

  /* TOP run (heading east): a hump, then the TWO big satellite LOOPS (each diverts up
   *  and away into a loop and rejoins). Built FIRST; the bottom is sized to match. */
  const startSegment = 'top-a';
  const afterTopA = b.run(startSegment, start, [STRAIGHT, ...HUMP]);
  /* The two loops are DIFFERENT — a big wide one and a smaller taller one — so the
   *  layout doesn't read as a stamped-out pattern. */
  const satA = addSatelliteLoop(b, afterTopA, { prefix: 'satA', flipped: true, riser: 2, span: 5 });
  b.link(startSegment, satA.inbound);
  const afterTopB = b.run('top-b', satA.exit, [STRAIGHT, ...HUMP_SM]);
  b.link(satA.segments.mergeThrough, 'top-b');
  b.link(satA.segments.mergeBranch, 'top-b');
  const satB = addCrossoverLoop(b, afterTopB, { prefix: 'satB', flipped: true });
  b.link('top-b', satB.inbound);
  const afterTopC = b.run('top-c', satB.exit, [STRAIGHT, ...HUMP, STRAIGHT]);
  b.link(satB.segments.mergeThrough, 'top-c');
  b.link(satB.segments.mergeBranch, 'top-c');

  /* RIGHT end: a semicircle down to the bottom run (turns east → west). */
  const afterSemiR = b.run('semi-r', afterTopC, SEMI);
  b.link('top-c', 'semi-r');

  /* BOTTOM run (heading west): WINDS via a varied mix of humps, then near the LEFT a
   *  YARD tap drops the trapezoid yard below the loop (bottom-left), then a filler
   *  closes back to the start x. Humps (not straights) absorb the satellites' length
   *  so the bottom stays curvy. */
  const afterBotA = b.run('bot-a', afterSemiR, [STRAIGHT, ...HUMP]);
  b.link('semi-r', 'bot-a');
  const cycle = [HUMP, HUMP_BIG, HUMP_SM, HUMP, HUMP_SM];
  const botSpecs: PieceSpec[] = [];
  let spanLeft = afterBotA.x - start.x - 900; // room for the yard tap + the closing filler
  for (let i = 0; spanLeft > 0 && i < 40; i++) {
    const h = cycle[i % cycle.length] ?? HUMP;
    const adv = travel(h);
    if (adv > spanLeft) break;
    botSpecs.push(...h);
    spanLeft -= adv;
  }
  const afterBotHumps = b.run('bot-b', afterBotA, botSpecs.length > 0 ? botSpecs : [STRAIGHT]);
  b.link('bot-a', 'bot-b');

  /* YARD tap near the left. The divert drops onto a BUFFERED LEAD-IN — a holding
   *  siding, leveled off the 45° divert and run clear of the running line — so a train
   *  bound for the yard pulls FULLY off the main loop before any slow shunting; the
   *  yard never blocks the running line. The parallelogram yard (flipped, so it hangs
   *  BELOW the westbound run) grows off the end of the lead-in. */
  const yard = tap(b, 'bot-b', afterBotHumps, 'yard', true);
  const LEVEL: PieceSpec = { type: 'curve', radiusMm: 241 };
  const leadInEnd = b.run('yard-leadin', yard.taps.branchExit, [LEVEL, STRAIGHT, STRAIGHT, STRAIGHT]);
  b.link(yard.taps.branchSeg, 'yard-leadin');
  const pgYard = addParallelogramYard(b, leadInEnd, { prefix: 'YD', slots: 5, flipped: true });
  b.link('yard-leadin', pgYard.topLeadIn);

  /* Close the running line from the yard tap's through back to the start x. */
  const closeRemaining = yard.onward.x - start.x;
  const full = Math.max(0, Math.floor(closeRemaining / 200 + 1e-6));
  const filler = closeRemaining - full * 200;
  const botCloseSpecs = side(full);
  if (filler > 0.5) botCloseSpecs.push({ type: 'straight', lengthMm: filler });
  const afterBotClose = b.run(
    'bot-d',
    yard.onward,
    botCloseSpecs.length > 0 ? botCloseSpecs : [STRAIGHT],
  );
  b.link(yard.taps.throughSeg, 'bot-d');

  /* LEFT end: a semicircle back up to the start. */
  const afterSemiL = b.run('semi-l', afterBotClose, SEMI);
  b.link('bot-d', 'semi-l');
  b.link('semi-l', startSegment); // close the loop

  const closureGapMm = Math.hypot(afterSemiL.x - start.x, afterSemiL.y - start.y);
  const built = b.build();
  return {
    net: built.net,
    pieces: built.pieces,
    geom: built.geom,
    branches: { yard: yard.taps, satA: satA.segments, satB: satB.segments },
    yard: pgYard.segments,
    startSegment,
    closureGapMm,
  };
}
