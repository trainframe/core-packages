/**
 * Track piece primitives for the visual track builder.
 *
 * Coordinates are in millimetres. A piece's position is its reference origin
 * (typically the centre of the piece). Rotation is applied around that origin.
 * Endpoints are returned in world space.
 *
 * All angles are in degrees, measured clockwise from the positive-x axis
 * (east), consistent with SVG's transform conventions.
 */

export type TrackPieceType =
  | 'straight'
  | 'curve'
  | 'junction'
  | 'station'
  | 'terminus'
  | 'crossing'
  | 'ramp'
  | 'train'
  | 'gate'
  | 'carriage';

/**
 * Piece types that represent devices (trains, gates, carriages) rather than
 * track topology. They sit *on* the table but contribute no endpoints or edges
 * to the compiled `Layout` — they're scanned onto the bus via `ScanBox`, not
 * compiled into the world's shape.
 *
 * Note: carriages are device pieces (no topology) but NOT wire devices — they
 * carry no RFID tag and emit nothing on the MQTT bus. Use `isWireDevice` to
 * distinguish the two.
 */
export const DEVICE_PIECE_TYPES = ['train', 'gate', 'carriage'] as const;
export type DevicePieceType = (typeof DEVICE_PIECE_TYPES)[number];

export function isDevicePiece(type: TrackPieceType): type is DevicePieceType {
  return type === 'train' || type === 'gate' || type === 'carriage';
}

/**
 * Wire-visible device types. These are the subset of device pieces that
 * announce themselves on the MQTT bus (`device_registered`) and emit events.
 * Carriages are intentionally excluded — they are physical wagons with no
 * RFID tag; the system has no awareness of them on the wire.
 */
export type WireDeviceType = 'train' | 'gate';

export function isWireDevice(type: TrackPieceType): type is WireDeviceType {
  return type === 'train' || type === 'gate';
}

/**
 * The marker kind a track piece contributes to the layout / scan flow.
 *
 * The scan-box (in `ToyTable`) and the private layout compiler (in
 * `layout-from-pieces`) MUST agree on this mapping; otherwise the server
 * learns one marker kind from the scan and the in-browser sim invents
 * another, and routes can't resolve. Defined here, next to the piece types,
 * to keep the two callers from drifting.
 *
 * Device pieces (train, gate) never become markers — they're scanned as
 * their own devices, not as topology. We return `'block_boundary'` for them
 * defensively so the function is total, but no caller should reach this path.
 */
export type TrackMarkerKind = 'block_boundary' | 'station_stop' | 'junction' | 'terminus';
export function pieceMarkerKind(type: TrackPieceType): TrackMarkerKind {
  if (type === 'station') return 'station_stop';
  if (type === 'junction') return 'junction';
  if (type === 'terminus') return 'terminus';
  // A ramp is just a length of track whose two ends sit on different layers —
  // logically an ordinary block boundary. We deliberately do NOT invent a new
  // TrackMarkerKind: the scan-box → server mapping and this compiler must stay
  // in lockstep, and the layer transition is editor-only metadata, never on the
  // wire (see docs/research/bridges-and-height-layers.md, Option A).
  return 'block_boundary';
}

/** Rotation is constrained to multiples of 45° in the range [0, 315]. */
export type RotationDeg = 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315;

export interface TrackPiece {
  readonly id: string;
  readonly type: TrackPieceType;
  readonly position: { readonly x: number; readonly y: number };
  readonly rotationDeg: RotationDeg;
  /** When true, the piece carries an RFID tag (renders a badge icon). */
  readonly tagged: boolean;
  /**
   * When true, the piece is mirrored across its local x-axis — a right-hand
   * curve becomes a left-hand curve, a junction's branch diverts the other way.
   * Applied before rotation. Omitted/undefined means not flipped. Symmetric
   * pieces (straight, station, crossing) are visually unaffected.
   */
  readonly flipped?: boolean;
  /**
   * Discrete editor height layer (0 = ground). Optional and presentational:
   * it never crosses the wire and the scheduler never sees it (see
   * docs/research/bridges-and-height-layers.md, Option A). It exists so the
   * editor can author stacked decks and so two pieces sharing a 2D footprint on
   * different layers do NOT auto-connect — that disjoint connectivity is what
   * makes a bridge a bridge. Mirrors the `flipped?` idiom: absent ⇒ ground;
   * never written as `layer: undefined` (exactOptionalPropertyTypes).
   */
  readonly layer?: number;
}

/** The single place the ground-layer default lives. Absent ⇒ layer 0. */
export function layerOf(piece: TrackPiece): number {
  return piece.layer ?? 0;
}

export interface TrackEndpoint {
  readonly x: number;
  readonly y: number;
  /** Angle (degrees, clockwise from east) at which a train exits this endpoint. */
  readonly outgoingAngleDeg: number;
  /**
   * The discrete height layer this endpoint sits on. Equals the owning piece's
   * layer for every piece EXCEPT the ramp, whose exit endpoint is one layer
   * higher (its `layerDelta` is 1). Required, computed once in `getEndpoints` —
   * the sole producer of TrackEndpoint literals — so clustering and snapping can
   * gate on it. Readers that ignore it are unaffected.
   */
  readonly layer: number;
}

export interface PieceShape {
  readonly svgPath: string;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Centreline turn radius of a curve piece, in mm. A curve is a 45° arc; eight
 * of them tile a full circle (8 × 45° = 360°). The endpoint geometry and the
 * rendered arc are both derived from this single constant so they can never
 * drift apart.
 */
const CURVE_RADIUS_MM = 200;

/** Half-width of a rendered rail band, in mm (band is 16 mm across). */
const RAIL_HALF_WIDTH = 8;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// ---------------------------------------------------------------------------
// Curve geometry (shared by endpoints and shape)
// ---------------------------------------------------------------------------
//
// The arc sweeps 45° about a centre, from `CURVE_ENTRY_ANGLE` to
// `CURVE_EXIT_ANGLE`. Crucially the piece *origin* is the arc midpoint, so the
// marker a curve contributes sits ON the rail — a train (or carriage) rendered
// at the marker rides the track instead of floating ~24 mm inside the bend.
const CURVE_ARC_CENTRE = { x: -100, y: CURVE_RADIUS_MM };
const CURVE_ENTRY_ANGLE = -90;
const CURVE_EXIT_ANGLE = -45;
const CURVE_MID_ANGLE = (CURVE_ENTRY_ANGLE + CURVE_EXIT_ANGLE) / 2;
/** Offset that moves the arc midpoint to the piece origin (0, 0). */
const CURVE_ORIGIN = {
  x: CURVE_ARC_CENTRE.x + CURVE_RADIUS_MM * Math.cos(toRad(CURVE_MID_ANGLE)),
  y: CURVE_ARC_CENTRE.y + CURVE_RADIUS_MM * Math.sin(toRad(CURVE_MID_ANGLE)),
};

/** A point on the curve's arc (at `radius` from the centre), in origin-relative
 * piece-local coordinates. */
function curvePoint(radius: number, angleDeg: number): { x: number; y: number } {
  return {
    x: CURVE_ARC_CENTRE.x + radius * Math.cos(toRad(angleDeg)) - CURVE_ORIGIN.x,
    y: CURVE_ARC_CENTRE.y + radius * Math.sin(toRad(angleDeg)) - CURVE_ORIGIN.y,
  };
}

/**
 * Rotate a point around the origin by `angleDeg` degrees (clockwise) then
 * translate by `tx, ty`.
 */
function transformPoint(
  lx: number,
  ly: number,
  angleDeg: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const rad = toRad(angleDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: tx + lx * cos - ly * sin,
    y: ty + lx * sin + ly * cos,
  };
}

function normaliseAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Local endpoint definitions (before piece rotation)
// ---------------------------------------------------------------------------

/**
 * Endpoints in piece-local space (piece origin = (0,0), pointing east).
 * The array is ordered by index; callers must preserve order to correctly
 * interpret endpoint roles (e.g. junction trunk = index 0).
 */
function localEndpoints(
  type: TrackPieceType,
): ReadonlyArray<{ lx: number; ly: number; localAngle: number; layerDelta?: number }> {
  switch (type) {
    case 'straight':
      // Two endpoints 200 mm apart, centred on origin.
      return [
        { lx: -100, ly: 0, localAngle: 180 },
        { lx: 100, ly: 0, localAngle: 0 },
      ];
    case 'ramp':
      // Reuses the straight's 200 mm footprint so snap spacing stays uniform,
      // but its exit endpoint (index 1) is one layer higher: this single
      // `layerDelta` IS the entire ramp/layer mechanism. Up vs down is pure
      // orientation — edges are bidirectional, so a "down ramp" is just a ramp
      // rotated 180°. Index-keyed delta is automatically flip/rotation-aware
      // (transforms never reorder endpoints).
      return [
        { lx: -100, ly: 0, localAngle: 180 }, // entry, on piece.layer
        { lx: 100, ly: 0, localAngle: 0, layerDelta: 1 }, // exit, on piece.layer + 1
      ];
    case 'curve': {
      // A true 45° circular arc, entry tangent pointing west (180°) and exit
      // tangent at 45°, both lying on one consistent arc — so eight curves
      // snapped end-to-end close into a circle (the old chord-approximation
      // endpoints did not). Origin is the arc midpoint, so the marker is on the
      // rail.
      const entry = curvePoint(CURVE_RADIUS_MM, CURVE_ENTRY_ANGLE);
      const exit = curvePoint(CURVE_RADIUS_MM, CURVE_EXIT_ANGLE);
      return [
        { lx: entry.x, ly: entry.y, localAngle: 180 },
        { lx: exit.x, ly: exit.y, localAngle: 45 },
      ];
    }
    case 'junction':
      // 3 endpoints: trunk (west, index 0), through (east, index 1), branch
      // (index 2). The branch diverges at 45° with its position and outgoing
      // tangent consistent (both down-right) and matching the curve's chirality,
      // so a curve continues it without a kink; Flip mirrors it to divert the
      // other way. (A fully-arced turnout — a branch radius matching the curve
      // piece — is a future refinement; the spur is a straight 45° for now.)
      return [
        { lx: -100, ly: 0, localAngle: 180 }, // trunk
        { lx: 100, ly: 0, localAngle: 0 }, // through (main)
        { lx: 100 * Math.cos(toRad(45)), ly: 100 * Math.sin(toRad(45)), localAngle: 45 }, // branch (divert)
      ];
    case 'station':
      // 220 mm straight with platform — same endpoint logic as straight.
      return [
        { lx: -110, ly: 0, localAngle: 180 },
        { lx: 110, ly: 0, localAngle: 0 },
      ];
    case 'terminus':
      // Single endpoint at the open end (east). Dead-end buffer at west.
      return [{ lx: 30, ly: 0, localAngle: 0 }];
    case 'crossing':
      // Two straights at 90°. Four endpoints: east, north, west, south.
      return [
        { lx: 100, ly: 0, localAngle: 0 }, // east
        { lx: 0, ly: -100, localAngle: 270 }, // north (SVG y-down, so -y = up)
        { lx: -100, ly: 0, localAngle: 180 }, // west
        { lx: 0, ly: 100, localAngle: 90 }, // south
      ];
    case 'train':
    case 'gate':
    case 'carriage':
      // Devices have no track endpoints — they sit on the table but contribute
      // no topology. compileLayout() ignores them via the empty-array path.
      return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * World-space endpoints for a placed piece, in the same order as the local
 * endpoint definitions (junction: [trunk, through, branch]; crossing: [east,
 * north, west, south]; all others: [entry, exit]).
 */
export function getEndpoints(piece: TrackPiece): ReadonlyArray<TrackEndpoint> {
  const locals = localEndpoints(piece.type);
  const flip = piece.flipped === true;
  const baseLayer = layerOf(piece);
  return locals.map(({ lx, ly, localAngle, layerDelta }) => {
    // Mirror across the local x-axis first (y and angle negate), then rotate +
    // translate — matching the SVG `scale(1,-1)` the renderer applies.
    const ly2 = flip ? -ly : ly;
    const localAngle2 = flip ? -localAngle : localAngle;
    const world = transformPoint(lx, ly2, piece.rotationDeg, piece.position.x, piece.position.y);
    return {
      x: world.x,
      y: world.y,
      outgoingAngleDeg: normaliseAngle(localAngle2 + piece.rotationDeg),
      // A ramp's exit endpoint carries a +1 layerDelta; every other endpoint
      // sits on the piece's own layer. This is the only place a single piece
      // spans two layers.
      layer: baseLayer + (layerDelta ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Centre-line sampling — the rail geometry from a piece's centre (its marker)
// out to one of its endpoints.
// ---------------------------------------------------------------------------
//
// `getEndpoints` answers "where are the rail ends?"; the renderer needs the
// path *between* the marker (piece centre = origin) and an end so a train can
// be drawn riding the true rail rather than the straight chord between two
// piece centres. A `CentreLinePath` samples that geometry by real arc-length.

/** A point on a rail with the train's heading there. */
export interface RailPose {
  readonly x: number;
  readonly y: number;
  /** Heading (degrees clockwise from east) of travel along the rail here. */
  readonly headingDeg: number;
}

/**
 * A sampleable rail segment from a piece's centre out to one endpoint.
 * `length` is the true rail length in mm (arc length for curves, Euclidean for
 * straights). `at(dist)` samples `dist` mm from the centre toward the endpoint;
 * heading points in the centre→endpoint travel direction.
 */
export interface CentreLinePath {
  readonly length: number;
  at(distFromCentre: number): RailPose;
}

/** Euclidean length of a vector. */
function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/**
 * A straight (linear) centre-line from the origin (0,0) out to `(ex, ey)` in
 * piece-local coordinates. Heading is the constant direction origin→endpoint.
 */
function linearHalfPath(ex: number, ey: number): CentreLinePath {
  const length = hypot(ex, ey);
  const headingDeg = length === 0 ? 0 : (Math.atan2(ey, ex) * 180) / Math.PI;
  const ux = length === 0 ? 0 : ex / length;
  const uy = length === 0 ? 0 : ey / length;
  return {
    length,
    at(distFromCentre: number): RailPose {
      return { x: ux * distFromCentre, y: uy * distFromCentre, headingDeg };
    },
  };
}

/**
 * The curve's centre-line from its origin (the arc midpoint) out to the
 * endpoint at arc angle `endAngleDeg`, sampled by real arc length. The piece
 * origin sits at `CURVE_MID_ANGLE`; travelling toward an endpoint sweeps the
 * arc angle toward `endAngleDeg`, and the heading is the arc tangent in that
 * travel direction (`arcAngle + 90` when sweeping positive, `- 90` otherwise).
 */
function curveHalfPath(endAngleDeg: number): CentreLinePath {
  const sweepSign = endAngleDeg >= CURVE_MID_ANGLE ? 1 : -1;
  const length = CURVE_RADIUS_MM * toRad(Math.abs(endAngleDeg - CURVE_MID_ANGLE));
  return {
    length,
    at(distFromCentre: number): RailPose {
      const arcAngle =
        CURVE_MID_ANGLE + (sweepSign * ((distFromCentre / CURVE_RADIUS_MM) * 180)) / Math.PI;
      const p = curvePoint(CURVE_RADIUS_MM, arcAngle);
      return { x: p.x, y: p.y, headingDeg: arcAngle + sweepSign * 90 };
    },
  };
}

/** The piece-local centre-line half-path for endpoint `index`, or undefined
 * when the index is out of range (e.g. a device piece with no endpoints). */
function localHalfPath(type: TrackPieceType, index: number): CentreLinePath | undefined {
  if (type === 'curve') {
    const endAngle = index === 0 ? CURVE_ENTRY_ANGLE : CURVE_EXIT_ANGLE;
    if (index !== 0 && index !== 1) return undefined;
    return curveHalfPath(endAngle);
  }
  const local = localEndpoints(type)[index];
  if (local === undefined) return undefined;
  return linearHalfPath(local.lx, local.ly);
}

/**
 * Wrap a piece-local `CentreLinePath` so its samples come out in world space,
 * applying the same mirror→rotate→translate the renderer (and `getEndpoints`)
 * use. `flip` mirrors across the local x-axis (y and heading negate) first.
 */
function worldHalfPath(piece: TrackPiece, local: CentreLinePath): CentreLinePath {
  const flip = piece.flipped === true;
  return {
    length: local.length,
    at(distFromCentre: number): RailPose {
      const pose = local.at(distFromCentre);
      const ly = flip ? -pose.y : pose.y;
      const heading = flip ? -pose.headingDeg : pose.headingDeg;
      const world = transformPoint(
        pose.x,
        ly,
        piece.rotationDeg,
        piece.position.x,
        piece.position.y,
      );
      return { x: world.x, y: world.y, headingDeg: normaliseAngle(heading + piece.rotationDeg) };
    },
  };
}

/**
 * World-space centre-line half-path for a placed `piece`, from its centre
 * (marker) out to endpoint `endpointIndex`. Returns `undefined` for an
 * out-of-range index (device pieces have none). Sampling at `length` reproduces
 * `getEndpoints(piece)[endpointIndex]`'s position and `outgoingAngleDeg`.
 */
export function getCentreLinePath(
  piece: TrackPiece,
  endpointIndex: number,
): CentreLinePath | undefined {
  const local = localHalfPath(piece.type, endpointIndex);
  if (local === undefined) return undefined;
  return worldHalfPath(piece, local);
}

/**
 * A height cue for a layer group: a drop-shadow offset + blur (and optional
 * opacity) the renderer turns into an SVG `filter`. Pure data, total over the
 * small layer range a Brio table uses; lives next to the piece model so the
 * visual height ramp is defined with the geometry, not buried in JSX.
 *
 * Layer 0 is the ground/baseline (no shadow). Each higher layer floats further
 * "above" the table with a larger, softer offset shadow. Layers beyond 2 clamp
 * to the layer-2 cue (a Brio table rarely stacks deeper).
 */
export function layerStyle(layer: number): {
  readonly dx: number;
  readonly dy: number;
  readonly blur: number;
  readonly opacity?: number;
} {
  if (layer <= 0) return { dx: 0, dy: 0, blur: 0 };
  if (layer === 1) return { dx: 0, dy: 6, blur: 4, opacity: 0.35 };
  return { dx: 0, dy: 12, blur: 8, opacity: 0.45 };
}

/**
 * SVG path string (and bounding box) for a piece, in piece-local coordinates.
 * The consumer is expected to apply an SVG `transform="translate(x,y) rotate(r)"`
 * around the piece origin.
 *
 * Shapes are intentionally simple but recognisable:
 * - straight: fat rectangle with sleeper lines
 * - curve: arc arc with sleeper marks
 * - junction: Y-fork with two rail lines
 * - station: straight + platform rectangle
 * - terminus: stub with buffer-stop bar
 * - crossing: two crossing rectangles
 */
export function getPieceShape(piece: TrackPiece): PieceShape {
  switch (piece.type) {
    case 'straight':
      return straightShape();
    case 'curve':
      return curveShape();
    case 'junction':
      return junctionShape();
    case 'station':
      return stationShape();
    case 'terminus':
      return terminusShape();
    case 'crossing':
      return crossingShape();
    case 'ramp':
      return rampShape();
    case 'train':
      return trainShape();
    case 'gate':
      return gateShape();
    case 'carriage':
      return carriageShape();
  }
}

// ---------------------------------------------------------------------------
// Shape builders (piece-local coordinates, origin at piece centre)
// ---------------------------------------------------------------------------

function straightShape(): PieceShape {
  // 200×16 rectangle with 5 sleeper lines.
  const w = 200;
  const h = 16;
  const half = w / 2;
  const halfH = h / 2;

  let d = `M ${-half} ${-halfH} H ${half} V ${halfH} H ${-half} Z`;

  // Sleepers: 5 vertical lines spaced 40 mm apart
  for (let i = -2; i <= 2; i++) {
    const x = i * 40;
    d += ` M ${x} ${-halfH} V ${halfH}`;
  }

  return { svgPath: d, width: w, height: h };
}

function curveShape(): PieceShape {
  // The rail band of the 45° arc, drawn on exactly the same geometry (and
  // origin) the endpoints use, so the band connects its own endpoint dots
  // instead of floating away from them.
  const outer = CURVE_RADIUS_MM + RAIL_HALF_WIDTH;
  const inner = CURVE_RADIUS_MM - RAIL_HALF_WIDTH;
  const at = (radius: number, deg: number): string => {
    const p = curvePoint(radius, deg);
    return `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  };

  // Outer arc entry→exit (sweep-flag 1 = the minor arc on screen), straight
  // across the band, inner arc back (sweep-flag 0), close.
  let d =
    `M ${at(outer, CURVE_ENTRY_ANGLE)} A ${outer} ${outer} 0 0 1 ${at(outer, CURVE_EXIT_ANGLE)} ` +
    `L ${at(inner, CURVE_EXIT_ANGLE)} A ${inner} ${inner} 0 0 0 ${at(inner, CURVE_ENTRY_ANGLE)} Z`;

  // Three sleeper ticks spread evenly across the 45° span.
  for (const deg of [-78.75, -67.5, -56.25]) {
    d += ` M ${at(inner, deg)} L ${at(outer, deg)}`;
  }

  return { svgPath: d, width: 160, height: 80 };
}

function junctionShape(): PieceShape {
  // Y-shape: trunk on left, straight through on right, branch diverging at 45°
  // down-right (matching the branch endpoint). Main rail band 16 mm wide.
  const bx = (100 * Math.cos(toRad(45))).toFixed(1);
  const by1 = (100 * Math.sin(toRad(45)) - 8).toFixed(1);
  const by2 = (100 * Math.sin(toRad(45)) + 8).toFixed(1);
  const d = `M -100 -8 H 100 V 8 H -100 Z M 0 -8 L ${bx} ${by1} L ${bx} ${by2} L 0 8 Z`;

  return { svgPath: d, width: 200, height: 80 };
}

function stationShape(): PieceShape {
  // 220 mm straight rail + 60×20 platform rectangle above it.
  const w = 220;
  const half = w / 2;
  // Rail band + platform above rail (60 mm wide, centred) + sleepers
  const d = `M ${-half} -8 H ${half} V 8 H ${-half} Z M -30 -28 H 30 V -8 H -30 Z M -80 -8 V 8 M 0 -8 V 8 M 80 -8 V 8`;

  return { svgPath: d, width: w, height: 36 };
}

function terminusShape(): PieceShape {
  // 60 mm stub with buffer-stop bar at the dead end (west).
  // Open end at east (+30), buffer at west (-30).
  // Rail band + buffer bar at west end
  const d = 'M -30 -8 H 30 V 8 H -30 Z M -30 -16 V 16 M -28 -16 H -30 M -28 16 H -30';

  return { svgPath: d, width: 60, height: 32 };
}

function crossingShape(): PieceShape {
  // Two 200 mm straights crossing at 90°.
  const half = 100;
  const hw = 8;
  // East-west rail + north-south rail
  const d = `M ${-half} ${-hw} H ${half} V ${hw} H ${-half} Z M ${-hw} ${-half} V ${half} H ${hw} V ${-half} Z`;

  return { svgPath: d, width: 200, height: 200 };
}

function rampShape(): PieceShape {
  // Same 200×16 rail band as a straight, plus three uphill chevrons pointing
  // toward the exit (east, the higher end) so the operator can read which way
  // the deck rises. The band is identical to the straight so the two snap and
  // tile interchangeably.
  const w = 200;
  const h = 16;
  const half = w / 2;
  const halfH = h / 2;
  let d = `M ${-half} ${-halfH} H ${half} V ${halfH} H ${-half} Z`;
  // Three chevrons (V opening downhill, apex uphill/east) spaced along the band.
  for (const cx of [-50, 0, 50]) {
    d += ` M ${cx - 14} ${-halfH} L ${cx} 0 L ${cx - 14} ${halfH}`;
  }
  return { svgPath: d, width: w, height: h };
}

function trainShape(): PieceShape {
  // Small loco silhouette sized to ride on a rail (rail band is 16 mm wide).
  // 80 mm long, 24 mm wide, nose at east.
  const d = 'M -40 -12 H 24 L 40 0 L 24 12 H -40 Z';

  return { svgPath: d, width: 80, height: 24 };
}

function gateShape(): PieceShape {
  // Stylised lift-barrier sized to straddle a rail. Short post on the west,
  // horizontal arm to east, with three diagonal stripes. 80 mm wide, 22 mm tall.
  const d =
    'M -40 -6 H -32 V 11 H -40 Z M -32 -1 H 40 V 5 H -32 Z M -18 -1 L -10 5 M -2 -1 L 6 5 M 14 -1 L 22 5';

  return { svgPath: d, width: 80, height: 22 };
}

function carriageShape(): PieceShape {
  // Passenger carriage: 60 mm long, 24 mm wide. Smaller and boxier than the
  // loco (which is 80×24 with a pointed nose). Rounded corners via arc
  // segments; no nose — both ends are flat so multiple carriages chain cleanly.
  const w = 60;
  const h = 24;
  const hw = w / 2; // 30
  const hh = h / 2; // 12
  const r = 4; // corner radius
  // Rounded rectangle in SVG path notation.
  const d =
    `M ${-hw + r} ${-hh} H ${hw - r} A ${r} ${r} 0 0 1 ${hw} ${-hh + r} ` +
    `V ${hh - r} A ${r} ${r} 0 0 1 ${hw - r} ${hh} H ${-hw + r} ` +
    `A ${r} ${r} 0 0 1 ${-hw} ${hh - r} V ${-hh + r} A ${r} ${r} 0 0 1 ${-hw + r} ${-hh} Z`;

  return { svgPath: d, width: w, height: h };
}
