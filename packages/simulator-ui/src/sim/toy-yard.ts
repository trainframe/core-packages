/**
 * The toy-table RAILYARD GANTRY adapter — turning a placed `railyard` device piece over
 * a patch of REAL track into a managed yard the real `YardZoneDevice` services on
 * physics, IN THE ONE UNIFIED WORLD.
 *
 * The model (ADR-030 + the toybox keystone): the operator drops a metal gantry over a
 * fan of stabling roads they built from ordinary pieces. The gantry owns NO track of its
 * own; it IDENTIFIES the slots under its footprint (`discoverYardSlots`, geometry-only)
 * and then drives THOSE ACTUAL segments. The operator's slots are ALREADY in the one
 * `compileNetwork(pieces).net` alongside any running loop, so NO synthetic interior and
 * NO second world are built — a running loop and a managed yard COEXIST because they are
 * the same network.
 *
 * ── From discovered slots to a drivable yard ────────────────────────────────
 * `discoveredYardLayout` (the general sibling of `parallelogramYardLayout`) projects the
 * discovered slot segments into the `YardLayout` the reused `YardController` drives — the
 * slot geom, the entry/exit leads, and the per-slot ladder throws — all inferred from the
 * SAME compiled net's adjacency. `layout.net` IS `compiled.net`: the gantry drives the
 * operator's pieces in place. The caller binds two `SwitchActuator`s (west/east) to the
 * per-slot throws via `discoveredYardActuator`; the controller, which thinks in a single
 * multi-position diverge/converge switch, is none the wiser. Finding no fan of ≥2 roads
 * fronting two leads, the gantry has no yard to work and STALLS.
 *
 * Pure geometry: positions from the gantry placement + the compiled network's endpoints.
 * No DOM, no clock, no randomness.
 */
import { type Footprint, discoverYardSlots } from '@trainframe/simulator/physics/discover-yard.js';
import {
  type DiscoveredYard as DiscoveredYardLayoutResult,
  type SlotLadder,
  discoveredYardLayout,
} from '@trainframe/simulator/physics/discovered-yard-layout.js';
import type { CompiledNetwork } from '@trainframe/simulator/physics/network-from-pieces.js';
import type { YardLayout } from '@trainframe/simulator/physics/yard.js';
import {
  RAILYARD_FRAME_BOT_MM,
  RAILYARD_FRAME_TOP_MM,
  RAILYARD_HALF_LENGTH_MM,
  type TrackPiece,
  transformPoint,
} from '@trainframe/simulator/track/pieces.js';

/** Discovery's slot-length floor (mm) on the toy table: a road is one segment per piece
 *  (~150 mm), so the floor is relaxed below the 300 mm default — a fan of ≥ 2 parallels is
 *  what matters, not their length. */
const TOY_SLOT_MIN_LENGTH_MM = 150;

/** A discovered, drivable yard the gantry manages on the operator's REAL slots, in the
 *  ONE unified world (`compiled.net`). The caller binds the two ladder actuators to
 *  `ladder` (west/east) and services it with a `YardZoneDevice`. */
export interface DiscoveredYard {
  /** The `YardController`-ready view of the discovered slots. `layout.net` IS the
   *  operator's `compileNetwork` net — the gantry drives the real slots in place. */
  readonly layout: YardLayout;
  /** Per-slot, per-side junction throws the caller binds the two `SwitchActuator`s to. */
  readonly ladder: readonly SlotLadder[];
  /** Where a visitor parks at the throat — the world point the throat camera reads. */
  readonly throatPoint: { x: number; y: number };
  /** The discovered operator slot segment ids under the footprint (what triggered the
   *  gantry — for inspection / rendering). */
  readonly discoveredSlots: readonly string[];
}

/** The footprint of a railyard gantry piece in world mm — the rectangle (its drawn
 *  frame) the operator dropped over the slots, rotated into world space. */
export function yardFootprintOf(piece: TrackPiece): Footprint {
  const halfX = RAILYARD_HALF_LENGTH_MM;
  const corners = [
    { lx: -halfX, ly: RAILYARD_FRAME_TOP_MM },
    { lx: halfX, ly: RAILYARD_FRAME_TOP_MM },
    { lx: -halfX, ly: RAILYARD_FRAME_BOT_MM },
    { lx: halfX, ly: RAILYARD_FRAME_BOT_MM },
  ].map((c) => transformPoint(c.lx, c.ly, piece.rotationDeg, piece.position.x, piece.position.y));
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of corners) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
}

/** The `M-{pieceId}` switch ids of the operator's junctions — what the discovered-yard
 *  adapter needs to recognise a slot's feeding turnout in the compiled net. */
function junctionSwitchIds(pieces: ReadonlyArray<TrackPiece>): string[] {
  return pieces.filter((p) => p.type === 'junction').map((p) => `M-${p.id}`);
}

/**
 * Build the gantry's drivable yard over the operator's REAL slots in the ONE compiled
 * world, or `null` when no fan of slots fronting two leads is found under the footprint
 * (the gantry stalls). The slots are driven IN PLACE — no synthetic net, no translation.
 */
export function buildDiscoveredYard(
  compiled: CompiledNetwork,
  footprint: Footprint,
  pieces: ReadonlyArray<TrackPiece>,
): DiscoveredYard | null {
  /* Discovery: identify the fan of stabling roads under the gantry. Finding fewer than
   *  two parallel roads (or a fan fronting no two leads), the gantry has no yard. */
  const discoveredSlots = discoverYardSlots(
    compiled.net.segments(),
    compiled.geom,
    footprint,
    TOY_SLOT_MIN_LENGTH_MM,
  );
  if (discoveredSlots.length < 2) return null;

  const result: DiscoveredYardLayoutResult | null = discoveredYardLayout(
    compiled.net,
    compiled.geom,
    discoveredSlots,
    { junctionSwitchIds: junctionSwitchIds(pieces) },
  );
  if (result === null) return null;

  return {
    layout: result.layout,
    ladder: result.ladder,
    throatPoint: result.throatPoint,
    discoveredSlots,
  };
}
