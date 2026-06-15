/**
 * Compile a layout assembled from REAL track pieces (`track/pieces.ts`) into a
 * physics `RailNetwork` — so a scene's geometry comes from actual straights,
 * curves and turnouts (the standard Brio-compatible radii), NOT hand-authored
 * bezier curves. A tight curve therefore can't sneak in: a piece's radius is
 * whatever the piece is, and the physics' lateral-acceleration limit derails an
 * over-fast train on it exactly as on any other curve.
 *
 * The builder is a turtle: `run(id, specs)` lays a sequence of pieces from the
 * current cursor (each piece's connect endpoint landing on the last piece's exit,
 * the placement maths mirroring `placement.ts`/`bridge-demo.ts`), turns that
 * sequence into ONE `Rail` segment via `buildRail`, and records its world end
 * points. `link()` joins segment ends (plain or switch-gated). `close()` links a
 * loop's last segment back to its first. `build()` returns the `RailNetwork` plus
 * the placed `TrackPiece[]` (for rendering + `compileLayout`) and each segment's
 * world endpoints (for markers).
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import {
  type RotationDeg,
  type TrackPiece,
  type TrackPieceType,
  getEndpoints,
} from '../track/pieces.js';
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import { type Rail, buildRail, railOfPiece } from './rail.js';

/** The turtle's pose between placements: the world point a new piece's connect
 *  endpoint lands on, the rail direction there (deg, clockwise from east), and
 *  the height layer. */
export interface Cursor {
  readonly x: number;
  readonly y: number;
  readonly dir: number;
  readonly layer: number;
}

/** One piece to lay in a run. */
export interface PieceSpec {
  readonly type: TrackPieceType;
  readonly flipped?: boolean;
  readonly radiusMm?: number;
}

/** A segment's world endpoints (start = rail d 0, end = rail d length). */
export interface SegEndpoints {
  readonly start: { x: number; y: number };
  readonly end: { x: number; y: number };
}

/** Round an angle to the nearest 45°, normalised into [0, 315]. */
function toRotationDeg(deg: number): RotationDeg {
  return ((((Math.round(deg / 45) * 45) % 360) + 360) % 360) as RotationDeg;
}

/** Place one piece so its connect endpoint (index 0) lands on `cursor`, its rail
 *  continuing forward, and return the exit-endpoint (index 1) cursor. Mirrors
 *  `bridge-demo.ts`'s `place` for the 2-endpoint case. */
function placePiece(cursor: Cursor, spec: PieceSpec, id: string): { piece: TrackPiece; exit: Cursor } {
  const radiusExtra = spec.radiusMm !== undefined ? { radiusMm: spec.radiusMm } : {};
  const probe: TrackPiece = {
    id: '__probe__',
    type: spec.type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
    ...(spec.flipped === true ? { flipped: true } : {}),
    ...radiusExtra,
  };
  const connectLocal = getEndpoints(probe)[0];
  if (connectLocal === undefined) throw new Error(`piece-network: ${spec.type} has no endpoint 0`);
  const baseLayer = cursor.layer - connectLocal.layer;
  const rotationDeg = toRotationDeg(cursor.dir + 180 - connectLocal.outgoingAngleDeg);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedX = connectLocal.x * cos - connectLocal.y * sin;
  const rotatedY = connectLocal.x * sin + connectLocal.y * cos;
  const piece: TrackPiece = {
    id,
    type: spec.type,
    position: { x: cursor.x - rotatedX, y: cursor.y - rotatedY },
    rotationDeg,
    tagged: false,
    ...(spec.flipped === true ? { flipped: true } : {}),
    ...(baseLayer !== 0 ? { layer: baseLayer } : {}),
    ...radiusExtra,
  };
  const exitEp = getEndpoints(piece)[1];
  if (exitEp === undefined) throw new Error(`piece-network: ${spec.type} has no endpoint 1`);
  return {
    piece,
    exit: { x: exitEp.x, y: exitEp.y, dir: exitEp.outgoingAngleDeg, layer: exitEp.layer },
  };
}

export interface PieceNetwork {
  readonly net: RailNetwork;
  readonly pieces: readonly TrackPiece[];
  readonly geom: ReadonlyMap<string, SegEndpoints>;
}

/** A turtle that lays runs of real pieces and assembles them into a RailNetwork. */
export class PieceNetworkBuilder {
  private readonly placed: TrackPiece[] = [];
  private readonly segments = new Map<string, Rail>();
  private readonly geom = new Map<string, SegEndpoints>();
  private readonly links: NetLink[] = [];
  private serial = 0;

  /** Lay a RUN of pieces from `start`, building them into ONE segment `id`.
   *  Returns the exit cursor (where the next run/junction continues). */
  run(id: string, start: Cursor, specs: readonly PieceSpec[]): Cursor {
    const runPieces: TrackPiece[] = [];
    let cursor = start;
    for (const spec of specs) {
      const { piece, exit } = placePiece(cursor, spec, `${id}-p${this.serial++}`);
      runPieces.push(piece);
      this.placed.push(piece);
      cursor = exit;
    }
    const rail = buildRail(runPieces);
    this.segments.set(id, rail);
    this.geom.set(id, { start: rail.at(0), end: rail.at(rail.length) });
    return cursor;
  }

  /** Join the END of segment `from` to the START of segment `to`. Optionally
   *  gated by a switch position (a junction selects which `to` is live). */
  link(from: string, to: string, when?: { switchId: string; position: string }): void {
    this.links.push(when === undefined ? { from, to } : { from, to, when });
  }

  /**
   * Lay a turnout from `start` (its trunk endpoint lands on the cursor) and add its
   * TWO internal paths as segments — `thruSeg` (trunk→through) and `branchSeg`
   * (trunk→branch) — both starting at the trunk. The caller links the inbound
   * segment to BOTH (switch-gated on `switchId`: `thruPos` vs `branchPos`), so the
   * switch chooses which path a train takes. Returns the through + branch exit
   * cursors (where each onward run continues). `flipped` selects the divert side.
   */
  junction(
    thruSeg: string,
    branchSeg: string,
    start: Cursor,
    sw: { switchId: string; thruPos: string; branchPos: string },
    flipped?: boolean,
  ): { thruExit: Cursor; branchExit: Cursor } {
    const spec: PieceSpec = flipped === true ? { type: 'junction', flipped } : { type: 'junction' };
    const { piece } = placePiece(start, spec, `${thruSeg}-jp${this.serial++}`);
    this.placed.push(piece);
    const thruRail = railOfPiece(piece, 0, 1);
    const branchRail = railOfPiece(piece, 0, 2);
    this.segments.set(thruSeg, thruRail);
    this.segments.set(branchSeg, branchRail);
    this.geom.set(thruSeg, { start: thruRail.at(0), end: thruRail.at(thruRail.length) });
    this.geom.set(branchSeg, { start: branchRail.at(0), end: branchRail.at(branchRail.length) });
    const eps = getEndpoints(piece);
    const thru = eps[1];
    const branch = eps[2];
    if (thru === undefined || branch === undefined) {
      throw new Error('piece-network: junction piece lacks through/branch endpoints');
    }
    return {
      thruExit: { x: thru.x, y: thru.y, dir: thru.outgoingAngleDeg, layer: thru.layer },
      branchExit: { x: branch.x, y: branch.y, dir: branch.outgoingAngleDeg, layer: branch.layer },
    };
  }

  build(): PieceNetwork {
    return {
      net: buildNetwork(this.segments, this.links),
      pieces: this.placed,
      geom: this.geom,
    };
  }
}
