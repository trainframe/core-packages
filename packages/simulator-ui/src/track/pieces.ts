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
  | 'curve-tight'
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

/**
 * Physical length (mm) announced for a virtual train when it goes live, and
 * spawned into the in-browser sim. MUST be > 0 and < the shortest layout edge:
 * the server's scheduler only serialises a switched junction for length-aware
 * trains (it defers releasing the approach block until the head has travelled
 * the train's own length past the boundary). A point train (length 0) would
 * deadlock a diverging junction. The single source of truth shared by the
 * scan-box (`scanPiece`) and the sim spawn path (`ToyHardware`) so the wire
 * payload and the physics can never drift. See ADR-014 / the bridge demo.
 */
export const TRAIN_LENGTH_MM = 60;

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
  /**
   * Centreline turn-radius override (mm) for a `curve` / `curve-tight` piece.
   * Absent ⇒ the type's default (200 for `curve`, 100 for `curve-tight`). It
   * lets a build solve ONE arc's radius to land a chain exactly on a target
   * endpoint — used by the bridge demo's descent to close the down-ramp onto
   * J2's branch within ~1 mm rather than merely within snap. The same 45° sweep
   * and heading lattice hold for any radius (see `curveArcCentre`), so the
   * override only translates the arc's far end, never rotates it. Mirrors the
   * `flipped?` / `layer?` idiom: never written as `radiusMm: undefined`
   * (exactOptionalPropertyTypes). Ignored by non-curve pieces.
   */
  readonly radiusMm?: number;
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

/**
 * A drawable detail layered on top of a piece's wooden body — the platform of a
 * station, the buffer of a terminus, the windows and roof of a loco. The `role`
 * is semantic, not a colour: the renderer (and the design gallery) own the
 * palette and map each role to a fill/stroke, so the wood theme lives in one
 * place and pieces.ts stays pure geometry. `width` is the stroke width for the
 * stroked roles (`line`); ignored by filled roles.
 */
export type PieceFeatureRole =
  | 'platform' // raised, lighter-wood block (station platform)
  | 'dark-wood' // darker wood detail (terminus buffer, loco/carriage roof)
  | 'glass' // a window
  | 'metal' // grey metal fitting (gate post, buffer bumpers)
  | 'pop' // bright warm accent (headlight, chimney cap)
  | 'danger' // a red warning surface (the gate's barrier boom)
  | 'line'; // a stroked detail line (ramp chevrons, gate stripes)

export interface PieceFeature {
  readonly d: string;
  readonly role: PieceFeatureRole;
  readonly width?: number;
}

export interface PieceShape {
  /**
   * Outline of the piece's wooden body — filled with the wood/​tint material by
   * the renderer, and re-used as the selection/overlap highlight silhouette. For
   * device pieces (train/gate/carriage) this is the device's coloured body.
   */
  readonly svgPath: string;
  /**
   * Rail-groove polylines, stroked as recessed channels. Derived from the SAME
   * centre-line a train rides (`getCentreLinePath`), so the routed grooves and
   * the running rail can never disagree — and so grooves meet cleanly across a
   * snapped joint. Empty for device pieces.
   */
  readonly grooves: ReadonlyArray<string>;
  /** Detail overlays painted on top of the body (platform, buffer, windows…). */
  readonly features: ReadonlyArray<PieceFeature>;
  readonly width: number;
  readonly height: number;
}

/**
 * A gentle functional colour wash, layered over the beech wood at low opacity so
 * an operator can still read a piece's role at a glance without abandoning the
 * one-material look (ADR-aesthetic: "wood + function tints").
 *
 * Tints are WARM only, by necessity: a cool wash (blue/teal) over warm beech
 * desaturates to a drab grey rather than reading as colour. So the wash is used
 * where a warm hue both reads and helps — a station (honey), a terminus (brick),
 * a ramp (ochre). The pieces with the most distinctive SILHOUETTES — the Y-fork
 * junction and the plus crossing — carry no tint: their shape already reads, and
 * a grey wash would only muddy the wood. `null` ⇒ plain beech. Device pieces are
 * not wooden and ignore this table; they have their own body colour.
 */
export const PIECE_TINT: Record<TrackPieceType, string | null> = {
  straight: null,
  curve: null,
  'curve-tight': null,
  junction: null, // shape (a Y-fork) reads on its own — a cool wash would grey
  station: '#f0a02f', // warm honey
  terminus: '#d4513a', // brick-red — the line ends here
  crossing: null, // shape (a plus) reads on its own
  ramp: '#e0902a', // ochre — a change of level
  train: null,
  gate: null,
  carriage: null,
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Centreline turn radius of the standard `curve` piece, in mm. A curve is a 45°
 * arc; eight of them tile a full circle (8 × 45° = 360°). The endpoint geometry
 * and the rendered arc are both derived from this single constant so they can
 * never drift apart.
 */
const CURVE_RADIUS_MM = 200;

/**
 * Centreline turn radius of the `curve-tight` variant, in mm — half the
 * standard radius. Same 45° sweep (so it still tiles 8-to-a-circle and snaps
 * into the same 45° heading lattice), but a much smaller footprint, so a deck
 * can turn back on itself within a compact span. Added for the bridge demo's
 * flying junction, where the R=200 arc forced the elevated deck to sprawl into
 * a side-viaduct rather than cross cleanly over the ground line.
 */
const CURVE_TIGHT_RADIUS_MM = 100;

/** The centreline turn radius for a curve piece. An explicit `radiusMm` override
 * (a solved-radius arc) wins; otherwise the type's default. */
function curveRadiusFor(type: TrackPieceType, radiusOverride?: number): number {
  if (radiusOverride !== undefined && radiusOverride > 0) return radiusOverride;
  return type === 'curve-tight' ? CURVE_TIGHT_RADIUS_MM : CURVE_RADIUS_MM;
}

/**
 * Half-width of a rendered wooden plank, in mm (the plank is 26 mm across).
 * Purely VISUAL — the topology (endpoints, snapping, marker spacing) is unchanged
 * by how wide we draw the wood. Every body builder reads this one constant so
 * planks can never drift to different widths and mis-meet at a joint.
 */
const PLANK_HALF_WIDTH = 13;

/**
 * Distance (mm) of each routed rail groove from the piece centre-line — half the
 * track gauge. The two grooves sit at ±RAIL_GAUGE either side of the rail a train
 * actually rides. Single source of truth shared by every groove, so the twin
 * channels line up across a snapped joint.
 */
const RAIL_GAUGE = 5;

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
//
// The construction is parametrised by radius `R`: arc centre at (−R/2, R) puts
// the entry endpoint at (−R/2, 0) with a due-west tangent for any R, so both
// the standard `curve` (R=200) and the `curve-tight` variant (R=100) share one
// geometry and the same 45° heading lattice. (At R=200 the centre is (−100,
// 200), recovering the original constants.)
const CURVE_ENTRY_ANGLE = -90;
const CURVE_EXIT_ANGLE = -45;
const CURVE_MID_ANGLE = (CURVE_ENTRY_ANGLE + CURVE_EXIT_ANGLE) / 2;

/** Arc centre for a curve of the given radius (the marker is recentred to the
 * arc midpoint below). */
function curveArcCentre(radius: number): { x: number; y: number } {
  return { x: -radius / 2, y: radius };
}

/** Offset that moves the arc midpoint to the piece origin (0, 0). */
function curveOrigin(radius: number): { x: number; y: number } {
  const c = curveArcCentre(radius);
  return {
    x: c.x + radius * Math.cos(toRad(CURVE_MID_ANGLE)),
    y: c.y + radius * Math.sin(toRad(CURVE_MID_ANGLE)),
  };
}

/** A point at `pointRadius` from the centre of a curve whose centreline radius
 * is `radius`, at arc angle `angleDeg`, in origin-relative piece-local
 * coordinates. `pointRadius` differs from `radius` only when drawing the rail
 * band's inner/outer edges. */
function curvePointR(
  radius: number,
  pointRadius: number,
  angleDeg: number,
): { x: number; y: number } {
  const c = curveArcCentre(radius);
  const o = curveOrigin(radius);
  return {
    x: c.x + pointRadius * Math.cos(toRad(angleDeg)) - o.x,
    y: c.y + pointRadius * Math.sin(toRad(angleDeg)) - o.y,
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
  radiusOverride?: number,
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
    case 'curve':
    case 'curve-tight': {
      // A true 45° circular arc, entry tangent pointing west (180°) and exit
      // tangent at 45°, both lying on one consistent arc — so eight curves
      // snapped end-to-end close into a circle (the old chord-approximation
      // endpoints did not). Origin is the arc midpoint, so the marker is on the
      // rail. `curve-tight` is the same arc at half the radius.
      const r = curveRadiusFor(type, radiusOverride);
      const entry = curvePointR(r, r, CURVE_ENTRY_ANGLE);
      const exit = curvePointR(r, r, CURVE_EXIT_ANGLE);
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
  const locals = localEndpoints(piece.type, piece.radiusMm);
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
function curveHalfPath(radius: number, endAngleDeg: number): CentreLinePath {
  const sweepSign = endAngleDeg >= CURVE_MID_ANGLE ? 1 : -1;
  const length = radius * toRad(Math.abs(endAngleDeg - CURVE_MID_ANGLE));
  return {
    length,
    at(distFromCentre: number): RailPose {
      const arcAngle = CURVE_MID_ANGLE + (sweepSign * ((distFromCentre / radius) * 180)) / Math.PI;
      const p = curvePointR(radius, radius, arcAngle);
      return { x: p.x, y: p.y, headingDeg: arcAngle + sweepSign * 90 };
    },
  };
}

/**
 * A smooth cubic-Bézier centre-line from the origin (0,0) out to `(ex, ey)`,
 * leaving the origin along `startAngleDeg` and arriving at the endpoint along
 * `endAngleDeg`. Used for the junction BRANCH leg: a straight chord from the
 * junction centre to the 45° branch endpoint would make a train's heading JUMP
 * from the trunk axis (0°) to 45° at the junction centre. A Bézier tangent to
 * the trunk axis at the centre and to the branch direction at the endpoint
 * turns the train smoothly through the divert — with NO change to the endpoint
 * position, so connectivity and snapping are untouched.
 *
 * Sampling is by an arc-length lookup over a fixed set of parameter samples
 * (the curve is short and gently curved, so a modest sample count is exact to
 * well under a millimetre). Heading is the curve tangent in the travel
 * direction.
 */
function bezierHalfPath(
  ex: number,
  ey: number,
  startAngleDeg: number,
  endAngleDeg: number,
): CentreLinePath {
  // Control handle length: a third of the chord is the standard choice for a
  // visually circular-looking cubic; the exact value only affects the bulge of
  // the (short) turn, never the endpoints or their tangents.
  const chord = hypot(ex, ey);
  const handle = chord / 3;
  const s = toRad(startAngleDeg);
  const e = toRad(endAngleDeg);
  // p0 = origin, p3 = endpoint; p1/p2 set the end tangents.
  const p1x = handle * Math.cos(s);
  const p1y = handle * Math.sin(s);
  const p2x = ex - handle * Math.cos(e);
  const p2y = ey - handle * Math.sin(e);
  const bez = (t: number): { x: number; y: number } => {
    const u = 1 - t;
    const x = 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * ex;
    const y = 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * ey;
    return { x, y };
  };
  // Analytic tangent (derivative) of the cubic at parameter t, giving the EXACT
  // heading at both ends (0° at the centre, branch angle at the endpoint).
  const tangentDeg = (t: number): number => {
    const u = 1 - t;
    const dx = 3 * u * u * p1x + 6 * u * t * (p2x - p1x) + 3 * t * t * (ex - p2x);
    const dy = 3 * u * u * p1y + 6 * u * t * (p2y - p1y) + 3 * t * t * (ey - p2y);
    return dx === 0 && dy === 0 ? startAngleDeg : (Math.atan2(dy, dx) * 180) / Math.PI;
  };
  // Build an arc-length table over N samples (t and cumulative length).
  const N = 64;
  const pts: Array<{ t: number; x: number; y: number; s: number }> = [];
  let acc = 0;
  let prev = bez(0);
  pts.push({ t: 0, x: prev.x, y: prev.y, s: 0 });
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const cur = bez(t);
    acc += hypot(cur.x - prev.x, cur.y - prev.y);
    pts.push({ t, x: cur.x, y: cur.y, s: acc });
    prev = cur;
  }
  const length = acc;
  return {
    length,
    at(distFromCentre: number): RailPose {
      const target = Math.max(0, Math.min(length, distFromCentre));
      // Find the segment containing `target` and lerp within it (position by
      // arc length, heading from the analytic tangent at the lerped parameter).
      let i = 1;
      while (i < pts.length && (pts[i]?.s ?? length) < target) i++;
      const a = pts[i - 1];
      const b = pts[i] ?? a;
      if (a === undefined || b === undefined) return { x: 0, y: 0, headingDeg: startAngleDeg };
      const span = b.s - a.s;
      const f = span > 0 ? (target - a.s) / span : 0;
      const x = a.x + (b.x - a.x) * f;
      const y = a.y + (b.y - a.y) * f;
      const t = a.t + (b.t - a.t) * f;
      return { x, y, headingDeg: tangentDeg(t) };
    },
  };
}

/** The piece-local centre-line half-path for endpoint `index`, or undefined
 * when the index is out of range (e.g. a device piece with no endpoints). */
function localHalfPath(
  type: TrackPieceType,
  index: number,
  radiusOverride?: number,
): CentreLinePath | undefined {
  if (type === 'curve' || type === 'curve-tight') {
    const endAngle = index === 0 ? CURVE_ENTRY_ANGLE : CURVE_EXIT_ANGLE;
    if (index !== 0 && index !== 1) return undefined;
    return curveHalfPath(curveRadiusFor(type, radiusOverride), endAngle);
  }
  // Junction BRANCH leg (index 2): a smooth turn from the trunk axis at the
  // centre to the 45° branch endpoint, so a train diverting through the
  // junction doesn't snap its heading at the marker. The trunk (0) and through
  // (1) legs remain straight chords — they're collinear, already continuous.
  if (type === 'junction' && index === 2) {
    const branch = localEndpoints(type)[2];
    if (branch === undefined) return undefined;
    // Tangent at the centre is the trunk/through axis (0°, east); tangent at the
    // endpoint is the branch's own outgoing direction.
    return bezierHalfPath(branch.lx, branch.ly, 0, branch.localAngle);
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
  const local = localHalfPath(piece.type, endpointIndex, piece.radiusMm);
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
 * The drawable geometry of a piece, in piece-local coordinates (origin = piece
 * centre, pointing east). The consumer applies `transform="translate(x,y)
 * rotate(r)"` around the origin.
 *
 * A track piece is a wooden plank (`svgPath`, the body outline) with two routed
 * rail `grooves` derived from the centre-line a train actually rides, plus any
 * `features` (a station platform, a terminus buffer, ramp chevrons). A device
 * piece (train/gate/carriage) puts its coloured body in `svgPath` and its
 * detail (windows, lamps, the barrier boom) in `features`, with no grooves.
 *
 * The renderer owns the palette: it fills `svgPath` with the beech-wood material
 * (washed by `PIECE_TINT`), strokes `grooves` as recessed channels, and maps
 * each feature `role` to a fill/stroke. Keeping colour out of here leaves this
 * module pure geometry and lets the design gallery and the live `ToyTable` share
 * one source of truth for shape.
 */
export function getPieceShape(piece: TrackPiece): PieceShape {
  switch (piece.type) {
    case 'straight':
      return plankShape(200, []);
    case 'ramp':
      return plankShape(200, rampChevrons());
    case 'curve':
      return curveShape('curve', curveRadiusFor('curve', piece.radiusMm), piece.radiusMm);
    case 'curve-tight':
      return curveShape(
        'curve-tight',
        curveRadiusFor('curve-tight', piece.radiusMm),
        piece.radiusMm,
      );
    case 'junction':
      return junctionShape();
    case 'station':
      return stationShape();
    case 'terminus':
      return terminusShape();
    case 'crossing':
      return crossingShape();
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

const fmt = (n: number): string => n.toFixed(2);

/** A rounded-rectangle path, clockwise from the top-left, corner radius `r`. The
 * single rounded-plank primitive every straight-bodied piece is built from. */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const x2 = x + w;
  const y2 = y + h;
  const rr = Math.min(r, w / 2, h / 2);
  return (
    `M ${fmt(x + rr)} ${fmt(y)} H ${fmt(x2 - rr)} A ${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(x2)} ${fmt(y + rr)} ` +
    `V ${fmt(y2 - rr)} A ${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(x2 - rr)} ${fmt(y2)} ` +
    `H ${fmt(x + rr)} A ${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(x)} ${fmt(y2 - rr)} ` +
    `V ${fmt(y + rr)} A ${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(x + rr)} ${fmt(y)} Z`
  );
}

/** A small circle as a closed path (used for lamps, funnels, bumpers). */
function circle(cx: number, cy: number, r: number): string {
  return (
    `M ${fmt(cx - r)} ${fmt(cy)} a ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(r * 2)} 0 ` +
    `a ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-r * 2)} 0 Z`
  );
}

const PLANK_CORNER = 5;

/**
 * Sample a piece-local centre-line half-path and return the polyline that runs
 * `sign * RAIL_GAUGE` to one side of it (the routed groove). Sampling the SAME
 * `CentreLinePath` the train rides means the groove can never diverge from the
 * running rail — including through the junction branch, whose centre-line is a
 * bezier, not a straight 45° strip.
 */
function offsetGroove(local: CentreLinePath, sign: number): string {
  const samples = Math.max(2, Math.ceil(local.length / 8));
  let d = '';
  for (let i = 0; i <= samples; i++) {
    const pose = local.at((i / samples) * local.length);
    const normal = toRad(pose.headingDeg + 90);
    const x = pose.x + sign * RAIL_GAUGE * Math.cos(normal);
    const y = pose.y + sign * RAIL_GAUGE * Math.sin(normal);
    d += `${i === 0 ? 'M' : 'L'} ${fmt(x)} ${fmt(y)} `;
  }
  return d.trimEnd();
}

/**
 * A closed wooden band that follows a centre-line, `halfWidth` to each side —
 * the plank a curved leg rides. Sampled forward along one edge then back along
 * the other, so the wood sweeps along the very centre-line its grooves (and a
 * train) follow, instead of a straight chord. Used for the junction BRANCH.
 */
function sweptBandAlong(local: CentreLinePath, halfWidth: number): string {
  const samples = Math.max(2, Math.ceil(local.length / 6));
  const forward: string[] = [];
  const backward: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const pose = local.at((i / samples) * local.length);
    const nx = Math.cos(toRad(pose.headingDeg + 90));
    const ny = Math.sin(toRad(pose.headingDeg + 90));
    forward.push(`${fmt(pose.x + halfWidth * nx)} ${fmt(pose.y + halfWidth * ny)}`);
    backward.push(`${fmt(pose.x - halfWidth * nx)} ${fmt(pose.y - halfWidth * ny)}`);
  }
  // Traverse the near edge start→end then the far edge end→start. The winding is
  // chosen to match the through plank's roundRect (clockwise on screen) so the
  // nonzero fill UNIONs the two with no hole where they overlap at the throat.
  forward.reverse();
  return `M ${backward.join(' L ')} L ${forward.join(' L ')} Z`;
}

/**
 * Both routed grooves for every leg of a track piece, derived from its
 * centre-line half-paths. Each leg contributes a groove on each side; collinear
 * legs (a straight's two halves) join into one continuous rail, so the twin
 * channels are continuous through the piece and meet cleanly across a snapped
 * joint. Up to four legs (a crossing's four arms) are sampled.
 */
function centreLineGrooves(type: TrackPieceType, radiusOverride?: number): string[] {
  const grooves: string[] = [];
  for (let i = 0; i < 4; i++) {
    const local = localHalfPath(type, i, radiusOverride);
    if (local === undefined) continue;
    grooves.push(offsetGroove(local, 1), offsetGroove(local, -1));
  }
  return grooves;
}

/** A straight wooden plank of length `len`, centred on the origin, with its two
 * routed grooves. `features` overlay extra detail (e.g. the ramp chevrons). */
function plankShape(len: number, features: ReadonlyArray<PieceFeature>): PieceShape {
  const half = len / 2;
  return {
    svgPath: roundRect(-half, -PLANK_HALF_WIDTH, len, PLANK_HALF_WIDTH * 2, PLANK_CORNER),
    grooves: centreLineGrooves('straight'),
    features,
    width: len,
    height: PLANK_HALF_WIDTH * 2,
  };
}

/** Three uphill chevrons pointing toward the exit (east), read as the rising
 * deck of a ramp. Drawn as stroked detail lines over the wood. */
function rampChevrons(): ReadonlyArray<PieceFeature> {
  const features: PieceFeature[] = [];
  for (const cx of [-45, 0, 45]) {
    features.push({
      role: 'line',
      width: 3,
      d: `M ${cx - 12} -7.5 L ${cx} 0 L ${cx - 12} 7.5`,
    });
  }
  return features;
}

function curveShape(
  type: TrackPieceType,
  radius: number,
  radiusOverride: number | undefined,
): PieceShape {
  // The wooden band of the 45° arc, drawn on exactly the geometry the endpoints
  // use, so the plank connects its own ends instead of floating away from them.
  // Parametrised by centreline `radius` so the standard `curve` (R=200) and
  // `curve-tight` (R=100) share one builder.
  const outer = radius + PLANK_HALF_WIDTH;
  const inner = radius - PLANK_HALF_WIDTH;
  const at = (pointRadius: number, deg: number): string => {
    const p = curvePointR(radius, pointRadius, deg);
    return `${fmt(p.x)} ${fmt(p.y)}`;
  };
  const d =
    `M ${at(outer, CURVE_ENTRY_ANGLE)} A ${fmt(outer)} ${fmt(outer)} 0 0 1 ${at(outer, CURVE_EXIT_ANGLE)} ` +
    `L ${at(inner, CURVE_EXIT_ANGLE)} A ${fmt(inner)} ${fmt(inner)} 0 0 0 ${at(inner, CURVE_ENTRY_ANGLE)} Z`;
  return {
    svgPath: d,
    grooves: centreLineGrooves(type, radiusOverride),
    features: [],
    width: (180 * radius) / CURVE_RADIUS_MM,
    height: (90 * radius) / CURVE_RADIUS_MM,
  };
}

function junctionShape(): PieceShape {
  // A wooden Y: the through plank runs west↔east; the branch plank SWEEPS along
  // the same bezier centre-line its grooves (and a diverting train) follow, so
  // the branch wood curves WITH its rails instead of running off a straight 45°
  // chord. With no hard outline + one wood fill, the through plank and the
  // branch band read as a single forked piece; the diverging V between the legs
  // is open table, as on a real turnout.
  const ph = PLANK_HALF_WIDTH;
  const through = roundRect(-100, -ph, 200, ph * 2, PLANK_CORNER);
  const branchLocal = localHalfPath('junction', 2);
  const branch = branchLocal === undefined ? '' : sweptBandAlong(branchLocal, ph);
  // Branch endpoint y (the lowest reach), plus a plank half-width, sets the box.
  const branchEnd = localEndpoints('junction')[2];
  const ey = branchEnd?.ly ?? 70.71;
  return {
    svgPath: `${through} ${branch}`,
    grooves: centreLineGrooves('junction'),
    features: [],
    width: 200,
    height: ph + ey + ph,
  };
}

function stationShape(): PieceShape {
  // A 220 mm plank with a raised platform deck along its north (upper) edge.
  const ph = PLANK_HALF_WIDTH;
  const platformTop = -(ph + 22);
  const platform = roundRect(-52, platformTop, 104, 24, 4);
  // A thin platform-edge line gives the deck a lip facing the rail.
  const lip: PieceFeature = { role: 'line', width: 2, d: `M -50 ${-ph - 1} H 50` };
  return {
    svgPath: roundRect(-110, -ph, 220, ph * 2, PLANK_CORNER),
    grooves: centreLineGrooves('station'),
    features: [{ role: 'platform', d: platform }, lip],
    width: 220,
    height: ph - platformTop,
  };
}

function terminusShape(): PieceShape {
  // A short plank with a chunky wooden buffer-stop at the dead end (west); the
  // open end is east. Two metal bumper pads face the incoming train.
  const ph = PLANK_HALF_WIDTH;
  const buffer = roundRect(-38, -(ph + 3), 12, (ph + 3) * 2, 3);
  return {
    svgPath: roundRect(-30, -ph, 60, ph * 2, PLANK_CORNER),
    // Grooves stop short of the buffer; straight pair over the open stub.
    grooves: [`M -22 ${-RAIL_GAUGE} H 28`, `M -22 ${RAIL_GAUGE} H 28`],
    features: [
      { role: 'dark-wood', d: buffer },
      { role: 'metal', d: circle(-24, -RAIL_GAUGE, 2.6) },
      { role: 'metal', d: circle(-24, RAIL_GAUGE, 2.6) },
    ],
    width: 60,
    height: (ph + 3) * 2,
  };
}

function crossingShape(): PieceShape {
  // Two 200 mm planks crossing at 90°. Both rounded rects are wound the same
  // way, so the nonzero fill unions them into a plus with no hole at the centre.
  const ph = PLANK_HALF_WIDTH;
  const ew = roundRect(-100, -ph, 200, ph * 2, PLANK_CORNER);
  const ns = roundRect(-ph, -100, ph * 2, 200, PLANK_CORNER);
  return {
    svgPath: `${ew} ${ns}`,
    grooves: centreLineGrooves('crossing'),
    features: [],
    width: 200,
    height: 200,
  };
}

function trainShape(): PieceShape {
  // A friendly top-down loco, nose to the east. Rounded hull tapering to the
  // nose, a dark boiler/roof panel, a windscreen, a funnel and a headlamp.
  const body = 'M -40 -7 Q -40 -13 -34 -13 H 24 L 40 -5 L 40 5 L 24 13 H -34 Q -40 13 -40 7 Z';
  return {
    svgPath: body,
    grooves: [],
    features: [
      // Boiler / roof panel.
      { role: 'dark-wood', d: roundRect(-34, -9, 46, 18, 5) },
      // Funnel (dark ring + bright cap).
      { role: 'dark-wood', d: circle(2, 0, 5.5) },
      { role: 'pop', d: circle(2, 0, 2.4) },
      // Windscreen toward the nose.
      { role: 'glass', d: roundRect(16, -6, 9, 12, 2) },
      // Headlamp at the nose tip.
      { role: 'pop', d: circle(34, 0, 2.6) },
    ],
    width: 80,
    height: 26,
  };
}

function gateShape(): PieceShape {
  // A lift-barrier straddling the rail: a metal post + counterweight to the
  // west, a red-and-cream boom reaching east. The body silhouette covers post
  // and boom so the selection glow wraps the whole barrier; the coloured boom
  // and stripes are painted on top.
  const post = roundRect(-40, -12, 11, 24, 2);
  const boomBase = roundRect(-29, -3.5, 67, 7, 3);
  const stripes: PieceFeature[] = [];
  for (const sx of [-14, 6, 26]) {
    stripes.push({ role: 'platform', d: roundRect(sx, -3.5, 7, 7, 1) });
  }
  return {
    svgPath: `${post} ${boomBase}`,
    grooves: [],
    features: [
      { role: 'danger', d: boomBase },
      ...stripes,
      // Counterweight on the post.
      { role: 'metal', d: circle(-34.5, 8, 3.5) },
    ],
    width: 80,
    height: 24,
  };
}

function carriageShape(): PieceShape {
  // A passenger carriage: a rounded box, shorter than the loco, with a row of
  // windows and no nose so multiple carriages chain cleanly.
  const w = 60;
  const ph = 13;
  const windows: PieceFeature[] = [];
  for (const cx of [-18, -6, 6, 18]) {
    windows.push({ role: 'glass', d: roundRect(cx - 4, -5, 8, 10, 1.5) });
  }
  return {
    svgPath: roundRect(-w / 2, -ph, w, ph * 2, 6),
    grooves: [],
    features: [{ role: 'dark-wood', d: roundRect(-26, -ph, 52, 4, 2) }, ...windows],
    width: w,
    height: ph * 2,
  };
}
