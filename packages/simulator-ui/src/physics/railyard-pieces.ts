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
import type { SceneJunction, SceneMarker } from './markers.js';
import type { RailNetwork } from './network.js';
import { type PassingLoopSegments, addPassingLoop } from './passing-loop.js';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';
import { type RailyardMarkerLayer, buildRailyardMarkers } from './railyard-markers.js';
import { type YardLadderSegments, addYardLadder } from './yard-ladder.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const CURVE: PieceSpec = { type: 'curve' };

/** A 90° corner = two same-chirality 45° curves. */
const CORNER: readonly PieceSpec[] = [CURVE, CURVE];

/** A 180° U-turn (a semicircular end) = four same-chirality 45° curves. */
const SEMICIRCLE: readonly PieceSpec[] = [CURVE, CURVE, CURVE, CURVE];

/** A 180° U-turn that curves the OTHER way (flipped), so the oval body sits on the
 *  opposite side of the running line from the branch + yard sidings. */
const SEMICIRCLE_FLIPPED: readonly PieceSpec[] = [
  { type: 'curve', flipped: true },
  { type: 'curve', flipped: true },
  { type: 'curve', flipped: true },
  { type: 'curve', flipped: true },
];

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

export interface RailyardCircuitScene {
  readonly net: RailNetwork;
  readonly pieces: ReturnType<PieceNetworkBuilder['build']>['pieces'];
  readonly geom: ReturnType<PieceNetworkBuilder['build']>['geom'];
  /** The passing loop's segment ids + its scheduler-driven switch. */
  readonly passingLoop: PassingLoopSegments;
  /** Segment a train spawns on to start lapping the circuit. */
  readonly startSegment: string;
  /** End-to-start closure gap (mm) — asserted small by the test. */
  readonly closureGapMm: number;
}

/**
 * Build the full running circuit: an oval (two semicircular ends + two straight
 * sides) with a PASSING LOOP spliced into the bottom side, so a lapping train
 * either stays on the main or — when the scheduler throws the switch — diverts
 * round the siding and rejoins. Both routes are closed loops a train circulates
 * forever.
 *
 * Closure: the passing loop preserves heading and returns to the main line, so it
 * drops into the straight bottom; its through-route carries the turnout's ~24 mm
 * √2 residue, which the top side absorbs with one matching `lengthMm` filler
 * (`E mod 200`). Both ends are identical semicircles, so the oval closes when the
 * top spans the same east extent as the bottom — which it is built to do.
 */
export function buildRailyardCircuitScene(): RailyardCircuitScene {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };

  /* BOTTOM side (heading east) with the passing loop in its middle. */
  const startSegment = 'bot-a';
  const botA = b.run(startSegment, start, side(2));
  const {
    exit: afterPL,
    segments: passingLoop,
    inbound,
  } = addPassingLoop(b, botA, {
    prefix: 'PL',
    parallelStraights: 3,
  });
  b.link(startSegment, inbound);
  const botEnd = b.run('bot-b', afterPL, side(2));
  b.link(passingLoop.mergeThrough, 'bot-b');
  b.link(passingLoop.mergeBranch, 'bot-b');

  /* RIGHT end: U-turn to head back west. */
  const afterSemiR = b.run('semi-r', botEnd, SEMICIRCLE);
  b.link('bot-b', 'semi-r');

  /* TOP side (heading west): span the bottom's full east extent so the oval
   * closes, absorbing the passing loop's √2 residue in one short filler. */
  const east = botEnd.x - start.x;
  const full = Math.floor(east / 200 + 1e-6);
  const filler = east - full * 200;
  const topSpecs = side(full);
  if (filler > 0.5) topSpecs.push({ type: 'straight', lengthMm: filler });
  const afterTop = b.run('top', afterSemiR, topSpecs);
  b.link('semi-r', 'top');

  /* LEFT end: U-turn back to east, returning to the start. */
  const afterSemiL = b.run('semi-l', afterTop, SEMICIRCLE);
  b.link('top', 'semi-l');
  b.link('semi-l', startSegment); // close the circuit

  const closureGapMm = Math.hypot(afterSemiL.x - start.x, afterSemiL.y - start.y);
  const built = b.build();
  return {
    net: built.net,
    pieces: built.pieces,
    geom: built.geom,
    passingLoop,
    startSegment,
    closureGapMm,
  };
}

export interface FullRailyardScene {
  readonly net: RailNetwork;
  readonly pieces: ReturnType<PieceNetworkBuilder['build']>['pieces'];
  readonly geom: ReturnType<PieceNetworkBuilder['build']>['geom'];
  readonly passingLoop: PassingLoopSegments;
  readonly yard: YardLadderSegments;
  readonly startSegment: string;
  readonly closureGapMm: number;
  /** The sparse core markers (the layer the scheduler sees). */
  readonly markers: readonly SceneMarker[];
  /** The one core junction (the passing-loop switch). The yard throat switch is
   *  the yard DEVICE's, not core's, so it is intentionally absent. */
  readonly junctions: readonly SceneJunction[];
  /** The full marker layer (markers + junctions + directed edges + throat) for
   *  the `Layout` compiler and the demo's route/seed helpers. */
  readonly markerLayer: RailyardMarkerLayer;
  /** The yard-entry boundary marker id (`M-yard-throat`). */
  readonly throatMarker: string;
}

/**
 * The COMPLETE railyard layout from real pieces: the oval running circuit with the
 * passing-loop branch AND the in-line yard ladder both spliced into the bottom
 * running line. The semicircle ends curve the OPPOSITE way to the sidings, so the
 * oval body sits clear above the running line while the branch siding and the
 * yard's lead + dead-end slots hang below — the overlap check (in `build()`)
 * guarantees nothing crosses. A train laps the circuit; the scheduler can divert
 * it round the passing loop or admit it into the yard.
 */
export function buildFullRailyardScene(): FullRailyardScene {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };

  /* BOTTOM running line (heading east): lead-in, the passing-loop branch, a gap,
   * the yard ladder, lead-out. Both sidings hang below. */
  const startSegment = 'bot-a';
  const botA = b.run(startSegment, start, side(2));
  const pl = addPassingLoop(b, botA, { prefix: 'PL', parallelStraights: 3 });
  b.link(startSegment, pl.inbound);
  const afterPLrun = b.run('bot-mid', pl.exit, side(3));
  b.link(pl.segments.mergeThrough, 'bot-mid');
  b.link(pl.segments.mergeBranch, 'bot-mid');
  const yard = addYardLadder(b, afterPLrun, { prefix: 'Y', slots: 3 });
  b.link('bot-mid', yard.inbound);
  const botEnd = b.run('bot-b', yard.spineExit, side(2));
  b.link(yard.segments.spineThrough, 'bot-b');

  /* RIGHT + LEFT ends: flipped semicircles (oval body curves up, away from the
   * sidings below). TOP spans the bottom's extent, absorbing the √2 residue. */
  const afterSemiR = b.run('semi-r', botEnd, SEMICIRCLE_FLIPPED);
  b.link('bot-b', 'semi-r');
  const east = botEnd.x - start.x;
  const full = Math.floor(east / 200 + 1e-6);
  const filler = east - full * 200;
  const topSpecs = side(full);
  if (filler > 0.5) topSpecs.push({ type: 'straight', lengthMm: filler });
  const afterTop = b.run('top', afterSemiR, topSpecs);
  b.link('semi-r', 'top');
  const afterSemiL = b.run('semi-l', afterTop, SEMICIRCLE_FLIPPED);
  b.link('top', 'semi-l');
  b.link('semi-l', startSegment);

  const closureGapMm = Math.hypot(afterSemiL.x - start.x, afterSemiL.y - start.y);
  const built = b.build();

  /* The SPARSE marker layer, anchored to the real-piece segments now they exist:
   *  west lead-in, the passing turnout + its siding, the central station, the yard
   *  throat, the east lead-out, the north station on the far side. */
  const markerLayer = buildRailyardMarkers(built.net, {
    westSeg: startSegment,
    midSeg: 'bot-mid',
    eastSeg: 'bot-b',
    topSeg: 'top',
    passingInbound: pl.inbound,
    passingLoopSeg: pl.segments.loop,
    passingSwitchId: pl.segments.switchId,
    passingMainPos: pl.segments.mainPos,
    passingLoopPos: pl.segments.loopPos,
    yardInbound: yard.inbound,
  });

  return {
    net: built.net,
    pieces: built.pieces,
    geom: built.geom,
    passingLoop: pl.segments,
    yard: yard.segments,
    startSegment,
    closureGapMm,
    markers: markerLayer.markers,
    junctions: markerLayer.junctions,
    markerLayer,
    throatMarker: markerLayer.throatMarker,
  };
}
