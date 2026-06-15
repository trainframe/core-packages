/**
 * A PASSING LOOP (a.k.a. a passing siding) built from real track pieces: the main
 * line reaches a facing turnout that either continues straight OR diverts onto a
 * parallel loop that rejoins at a trailing turnout further along. This is the
 * "normal junction that goes off and reaches back" the demo needs — two genuine
 * routes between the same two points, selected by a scheduler-driven switch.
 *
 * The geometry is honest about a real constraint: the turnout's 45° branch is a
 * 241 mm-radius bezier while the curve piece is 200 mm-radius, so diverting and
 * levelling back leaves an irrational √2 longitudinal residue (~24 mm) that no
 * whole number of 200 mm straights can absorb. We close it the way the codebase
 * already closes the bridge descent — a single piece with a solved dimension: one
 * short `lengthMm` straight on the main between the turnouts (see TrackPiece
 * `lengthMm`). The loop then closes to well under a millimetre, no visible kink.
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import type { RailNetwork } from './network.js';
import {
  type Cursor,
  PieceNetworkBuilder,
  type PieceSpec,
  type SegEndpoints,
} from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const CURVE_LEVEL: PieceSpec = { type: 'curve', flipped: true };

/** Segment ids a passing loop contributes, so a caller can link it onward and a
 *  test can assert which route a train took. */
export interface PassingLoopSegments {
  /** Facing-turnout through path (stay on the main). */
  readonly mainThrough: string;
  /** Facing-turnout branch path (divert onto the loop). */
  readonly loopBranch: string;
  /** The divergent parallel run (the "siding"). */
  readonly loop: string;
  /** Straight main between the two turnouts (with the closing filler). */
  readonly mainMid: string;
  /** Trailing-turnout through path (main rejoining). */
  readonly mergeThrough: string;
  /** Trailing-turnout branch path (loop rejoining). */
  readonly mergeBranch: string;
  /** The switch id selecting main (through) vs loop (branch). */
  readonly switchId: string;
  /** Switch position that keeps a train on the main. */
  readonly mainPos: string;
  /** Switch position that sends a train round the loop. */
  readonly loopPos: string;
}

export interface PassingLoopOptions {
  /** Unique prefix for this loop's segment ids (so several can coexist). */
  readonly prefix: string;
  /** The switch id the scheduler drives (defaults to `${prefix}-SW`). */
  readonly switchId?: string;
  /** Straights along the parallel siding between its two levelling curves. */
  readonly parallelStraights?: number;
}

/**
 * Add a passing loop to `b` starting at `entry` (heading along `entry.dir`). All
 * of the loop's INTERNAL links are wired here; the caller wires only its own two
 * seams: its inbound run → the returned `inbound` segment, and the onward run ←
 * the merged trunk (link `segments.mergeThrough` and `segments.mergeBranch` to
 * it). Returns the exit cursor (the merged main, same heading), those segment ids,
 * and the `inbound` segment id.
 */
export function addPassingLoop(
  b: PieceNetworkBuilder,
  entry: Cursor,
  opts: PassingLoopOptions,
): { exit: Cursor; segments: PassingLoopSegments; inbound: string } {
  const p = opts.prefix;
  const switchId = opts.switchId ?? `${p}-SW`;
  const parallel = opts.parallelStraights ?? 2;
  const mainPos = 'main';
  const loopPos = 'loop';

  /* A short inbound stub so the caller has one segment to link the facing turnout
   * onto (the turnout's two internal paths both start at its trunk). */
  const inbound = `${p}-in`;
  const afterIn = b.run(inbound, entry, [STRAIGHT]);

  /* Facing turnout: stay straight (main) or divert down onto the loop. */
  const mainThrough = `${p}-mthru`;
  const loopBranch = `${p}-lbranch`;
  const { thruExit, branchExit } = b.junction(mainThrough, loopBranch, afterIn);

  /* The siding: level the 45° divert back to parallel, run alongside, level into
   * the converge approach (heading back toward the main). */
  const loop = `${p}-loop`;
  const conv = b.run(loop, branchExit, [
    CURVE_LEVEL,
    ...Array.from({ length: parallel }, () => STRAIGHT),
    CURVE_LEVEL,
  ]);

  /* Trailing turnout: the loop converges here; its branch endpoint lands on the
   * converge cursor, its through endpoint is where the straight main must arrive. */
  const mergeThrough = `${p}-mgthru`;
  const mergeBranch = `${p}-mgbranch`;
  const { trunkExit, thruEntry } = b.mergeJunction(mergeThrough, mergeBranch, conv, true);

  /* Straight main between the turnouts, sized to land exactly on the trailing
   * turnout's through endpoint: as many 200 mm straights as fit, then one short
   * `lengthMm` filler for the √2 residue. */
  const span = Math.hypot(thruEntry.x - thruExit.x, thruEntry.y - thruExit.y);
  const full = Math.floor(span / 200 + 1e-6);
  const filler = span - full * 200;
  const midSpecs: PieceSpec[] = Array.from({ length: full }, () => STRAIGHT);
  if (filler > 0.5) midSpecs.push({ type: 'straight', lengthMm: filler });
  const mainMid = `${p}-mid`;
  b.run(mainMid, thruExit, midSpecs);

  /* Wire the topology: facing turnout → (main | loop); each route → trailing
   * turnout; both trailing paths → the merged trunk (the returned exit). */
  b.link(inbound, mainThrough, { switchId, position: mainPos });
  b.link(inbound, loopBranch, { switchId, position: loopPos });
  b.link(mainThrough, mainMid);
  b.link(mainMid, mergeThrough);
  b.link(loopBranch, loop);
  b.link(loop, mergeBranch);

  return {
    exit: trunkExit,
    inbound,
    segments: {
      mainThrough,
      loopBranch,
      loop,
      mainMid,
      mergeThrough,
      mergeBranch,
      switchId,
      mainPos,
      loopPos,
    },
  };
}

export interface PassingLoopScene {
  readonly net: RailNetwork;
  readonly pieces: ReturnType<PieceNetworkBuilder['build']>['pieces'];
  readonly geom: ReadonlyMap<string, SegEndpoints>;
  readonly segments: PassingLoopSegments;
  /** Segment a train starts on (the approach into the loop). */
  readonly entrySegment: string;
  /** Segment a train ends on after the merge (the departure). */
  readonly exitSegment: string;
}

/**
 * Standalone scene: a short approach, a passing loop, and a departure. Used to
 * verify closure and that the switch genuinely selects between two routes that
 * both reach the same departure.
 */
export function buildPassingLoopScene(parallelStraights = 2): PassingLoopScene {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const entrySegment = 'approach';
  const entryExit = b.run(entrySegment, start, [STRAIGHT, STRAIGHT]);
  const { exit, segments, inbound } = addPassingLoop(b, entryExit, {
    prefix: 'PL',
    parallelStraights,
  });
  b.link(entrySegment, inbound);
  const exitSegment = 'depart';
  b.run(exitSegment, exit, [STRAIGHT, STRAIGHT]);
  b.link(segments.mergeThrough, exitSegment);
  b.link(segments.mergeBranch, exitSegment);
  const built = b.build();
  return {
    net: built.net,
    pieces: built.pieces,
    geom: built.geom,
    segments,
    entrySegment,
    exitSegment,
  };
}
