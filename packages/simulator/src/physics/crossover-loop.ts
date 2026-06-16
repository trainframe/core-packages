/**
 * A CROSSOVER LOOP spliced into a running line — like `satellite-loop.ts`, but the
 * detour is a teardrop that CROSSES OVER ITSELF once on a bridge: the returning leg
 * ramps up a height layer, passes over the outbound leg, and ramps back down. The
 * single grade-separated self-crossing is the layout's "the track crosses over
 * itself" feature (the overlap check forbids only SAME-layer fouling, so the
 * cross-layer crossing is legal and a flat one would be a build error).
 *
 * The teardrop shape (six quarter-turns, one of them an inward dent, net +360° so it
 * returns to the entry heading) was found by an exhaustive search for a loop that
 * closes back onto the line with EXACTLY one self-intersection; the ramps swap two of
 * its straights (a ramp reuses the straight's 200 mm footprint, so lifting a leg a
 * layer changes nothing in plan — only the height). Directional: a train diverts on,
 * runs the teardrop once, crosses over its own track, and rejoins heading the same way.
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import type { Cursor, PieceNetworkBuilder, PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const CURVE: PieceSpec = { type: 'curve' };
const FLIP: PieceSpec = { type: 'curve', flipped: true };
const RAMP: PieceSpec = { type: 'ramp' };
const RAMP_DOWN: PieceSpec = { type: 'ramp', connectVia: 1 };

/** Segment ids a crossover loop contributes (same shape as a satellite loop, so the
 *  scene wires it identically). */
export interface CrossoverLoopSegments {
  readonly mainThrough: string;
  readonly loopBranch: string;
  readonly loop: string;
  readonly mainMid: string;
  readonly mergeThrough: string;
  readonly mergeBranch: string;
  readonly switchId: string;
  readonly mainPos: string;
  readonly loopPos: string;
}

export interface CrossoverLoopOptions {
  readonly prefix: string;
  readonly switchId?: string;
  /** Which side the teardrop bulges (and the divert peels). `false` bulges toward
   *  +y (screen-down); `true` mirrors it. */
  readonly flipped?: boolean;
}

/**
 * The self-crossing teardrop, as a net-0° (net +360°) excursion that returns to the
 * entry line and heading. `cw`/`ccw` are the two 45° curve chiralities — swapping
 * them mirrors the whole teardrop to the other side of the line. Two straights are
 * RAMP / RAMP_DOWN so the returning leg rides a layer up across the outbound leg: a
 * bridge, not a foul. (Quarter = two same-chirality curves; the lone `ccw` quarter is
 * the inward dent that makes the loop cross itself.)
 */
function crossoverDetour(cw: PieceSpec, ccw: PieceSpec): PieceSpec[] {
  return [
    STRAIGHT,
    STRAIGHT,
    cw,
    cw, // quarter away from the line
    ccw,
    ccw, // the inward dent
    cw,
    cw,
    cw,
    cw, // around the loop
    STRAIGHT,
    cw,
    cw,
    STRAIGHT,
    RAMP, // climb a layer before the crossing
    cw,
    cw, // the returning leg passes OVER the outbound leg here
    RAMP_DOWN, // back down to the ground
    STRAIGHT,
  ];
}

/**
 * Add a crossover loop to `b` from `entry` (heading along `entry.dir`). Wires all
 * internal links; the caller links its inbound run → the returned `inbound` and the
 * onward run ← `segments.mergeThrough`/`mergeBranch`. Returns the exit cursor (the
 * merged main, same heading), the segment ids, and the `inbound` segment id.
 */
export function addCrossoverLoop(
  b: PieceNetworkBuilder,
  entry: Cursor,
  opts: CrossoverLoopOptions,
): { exit: Cursor; segments: CrossoverLoopSegments; inbound: string } {
  const p = opts.prefix;
  const switchId = opts.switchId ?? `${p}-SW`;
  const flipped = opts.flipped ?? false;
  const mainPos = 'main';
  const loopPos = 'loop';
  /* The detour's turn chiralities, and the curve that levels the 45° divert back
   *  parallel to the line — mirrored together so the teardrop sits on the chosen
   *  side. */
  const cw = flipped ? FLIP : CURVE;
  const ccw = flipped ? CURVE : FLIP;
  const lvl = flipped ? CURVE : FLIP;

  const inbound = `${p}-in`;
  const afterIn = b.run(inbound, entry, [STRAIGHT]);

  const mainThrough = `${p}-mthru`;
  const loopBranch = `${p}-lbranch`;
  const { thruExit, branchExit } = b.junction(mainThrough, loopBranch, afterIn, flipped);

  const loop = `${p}-loop`;
  const conv = b.run(loop, branchExit, [lvl, ...crossoverDetour(cw, ccw), lvl]);

  const mergeThrough = `${p}-mgthru`;
  const mergeBranch = `${p}-mgbranch`;
  const { trunkExit, thruEntry } = b.mergeJunction(mergeThrough, mergeBranch, conv, !flipped);

  const dist = Math.hypot(thruEntry.x - thruExit.x, thruEntry.y - thruExit.y);
  const full = Math.floor(dist / 200 + 1e-6);
  const filler = dist - full * 200;
  const midSpecs: PieceSpec[] = Array.from({ length: full }, () => STRAIGHT);
  if (filler > 0.5) midSpecs.push({ type: 'straight', lengthMm: filler });
  const mainMid = `${p}-mid`;
  b.run(mainMid, thruExit, midSpecs.length > 0 ? midSpecs : [STRAIGHT]);

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
