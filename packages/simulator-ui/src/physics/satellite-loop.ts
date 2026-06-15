/**
 * A SATELLITE LOOP spliced into a running line — a big detour that diverts off the
 * main at a facing turnout, swings out into a loop (a teardrop hanging off the line),
 * and rejoins at a trailing turnout. Same mechanism as a passing loop (`passing-loop.ts`),
 * scaled up: the detour is a big net-0° excursion that returns to the line, so the
 * trailing turnout auto-places where it arrives and a filler sizes the straight main
 * between the two turnouts. Directional — a train diverts on, swings round, and
 * rejoins heading the same way (no reversing).
 *
 * Optionally a `bridge` carries the detour UP a height layer, over the running line,
 * and back down — a grade-separated crossing (the overlap check only forbids
 * SAME-layer collisions). And an optional station branch taps off the detour.
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import type { Cursor, PieceNetworkBuilder, PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const CURVE: PieceSpec = { type: 'curve' };
const FLIP: PieceSpec = { type: 'curve', flipped: true };

/** Segment ids a satellite loop contributes. */
export interface SatelliteLoopSegments {
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

export interface SatelliteLoopOptions {
  readonly prefix: string;
  readonly switchId?: string;
  /** Straights up each side of the detour (sets the loop's size). */
  readonly riser?: number;
  /** Straights across the top of the detour. */
  readonly span?: number;
  /** Which side the loop bulges. `false` (default) bulges one way; `true` mirrors it
   *  — needed so a loop on the top run swings AWAY from the main interior, not into it. */
  readonly flipped?: boolean;
}

/** The big net-0° detour — a wide, rounded loop bulging off the line: turn away (90°),
 *  rise, turn along the top (90° back to parallel), run ACROSS (the loop's width), turn
 *  down (90°), drop, turn back onto the line (90°). The four 90° turns cancel
 *  (+90 −90 −90 +90 = 0) so the trailing turnout still converges; `riser` sets the
 *  height, `span` the width. `out` turns away from the line, `inn` is its mirror. */
function detour(out: PieceSpec, inn: PieceSpec, riser: number, span: number): PieceSpec[] {
  const straights = (n: number) => Array.from({ length: n }, () => STRAIGHT);
  return [
    out,
    out, // turn up, away from the line
    ...straights(riser), // rise
    inn,
    inn, // turn back to parallel — along the top
    ...straights(span), // run across the top (the loop's width)
    inn,
    inn, // turn down
    ...straights(riser), // drop
    out,
    out, // turn back onto the line
  ];
}

/**
 * Add a satellite loop to `b` starting at `entry` (heading along `entry.dir`). Wires
 * all internal links; the caller links its inbound run → the returned `inbound` and
 * the onward run ← `segments.mergeThrough`/`mergeBranch`. Returns the exit cursor (the
 * merged main, same heading), the segment ids, and the `inbound` segment id.
 */
export function addSatelliteLoop(
  b: PieceNetworkBuilder,
  entry: Cursor,
  opts: SatelliteLoopOptions,
): { exit: Cursor; segments: SatelliteLoopSegments; inbound: string } {
  const p = opts.prefix;
  const switchId = opts.switchId ?? `${p}-SW`;
  const riser = opts.riser ?? 3;
  const span = opts.span ?? 3;
  const flipped = opts.flipped ?? false;
  const mainPos = 'main';
  const loopPos = 'loop';
  /* `out` turns the detour AWAY from the line; `lvl` levels the divert (the mirror).
   *  Flipping swaps them, so the loop swings to the other side. */
  const out = flipped ? FLIP : CURVE;
  const lvl = flipped ? CURVE : FLIP;

  const inbound = `${p}-in`;
  const afterIn = b.run(inbound, entry, [STRAIGHT]);

  /* Facing turnout: stay straight (main) or divert onto the loop. */
  const mainThrough = `${p}-mthru`;
  const loopBranch = `${p}-lbranch`;
  const { thruExit, branchExit } = b.junction(mainThrough, loopBranch, afterIn, flipped);

  /* The detour: level the 45° divert back toward the line, swing out into the big
   *  loop, level into the converge approach. */
  const loop = `${p}-loop`;
  const conv = b.run(loop, branchExit, [
    lvl,
    ...detour(out, flipped ? CURVE : FLIP, riser, span),
    lvl,
  ]);

  /* Trailing turnout where the loop converges; the main between is filler-sized. */
  const mergeThrough = `${p}-mgthru`;
  const mergeBranch = `${p}-mgbranch`;
  const { trunkExit, thruEntry } = b.mergeJunction(mergeThrough, mergeBranch, conv, !flipped);

  const dist = Math.hypot(thruEntry.x - thruExit.x, thruEntry.y - thruExit.y);
  const full = Math.floor(dist / 200 + 1e-6);
  const filler = dist - full * 200;
  const midSpecs: PieceSpec[] = Array.from({ length: full }, () => STRAIGHT);
  if (filler > 0.5) midSpecs.push({ type: 'straight', lengthMm: filler });
  const mainMid = `${p}-mid`;
  b.run(mainMid, thruExit, midSpecs);

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
