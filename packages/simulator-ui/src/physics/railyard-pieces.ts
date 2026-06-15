/**
 * The railyard demo layout assembled from REAL track pieces (`pieces.ts`) on its
 * Brio-style grid (200 mm straights, 45°/R200 curves, 45° diverts) — NOT
 * hand-authored bezier. Compiled to a physics `RailNetwork` by
 * `PieceNetworkBuilder`. Loops close because every piece sits on the same grid and
 * the turtle joins each exactly to the last; a tight curve can't sneak in (a
 * piece's radius is whatever the piece is), and a deliberate crossing would use
 * the `crossing` piece while an accidental overlap is a build-time error.
 *
 * This module grows in slices: the MAIN running loop first (a rounded rectangle of
 * real straights + 45° corners), with its station markers; branches + the in-line
 * yard follow, each verified by closure/liveness tests before wiring the demo.
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import type { RailNetwork } from './network.js';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const CURVE: PieceSpec = { type: 'curve' };

/** A 90° corner = two same-chirality 45° curves. */
const CORNER: readonly PieceSpec[] = [CURVE, CURVE];

/** A side of the main loop = `n` straights. */
function side(n: number): PieceSpec[] {
  return Array.from({ length: n }, () => STRAIGHT);
}

export interface RailyardPieceScene {
  readonly net: RailNetwork;
  /** The placed real pieces (for rendering + `compileLayout`). */
  readonly pieces: ReturnType<PieceNetworkBuilder['build']>['pieces'];
  /** Segment id → world endpoints. */
  readonly geom: ReturnType<PieceNetworkBuilder['build']>['geom'];
  /** The single main-loop segment id (a closed run). */
  readonly mainLoop: string;
}

/**
 * Build the MAIN running loop: a rounded rectangle of real pieces — a long bottom
 * + top and shorter sides, joined by 45°×2 corners (8 curves = 360°, so it
 * closes). Returned as ONE closed segment linked end→start.
 */
export function buildMainLoopScene(): RailyardPieceScene {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const LONG = 4; // straights along the top + bottom runs
  const SHORT = 2; // straights up each side
  b.run('main', start, [
    ...side(LONG),
    ...CORNER,
    ...side(SHORT),
    ...CORNER,
    ...side(LONG),
    ...CORNER,
    ...side(SHORT),
    ...CORNER,
  ]);
  b.link('main', 'main'); // close the loop (end → start)
  const built = b.build();
  return { net: built.net, pieces: built.pieces, geom: built.geom, mainLoop: 'main' };
}
