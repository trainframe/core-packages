/**
 * Track piece primitives for the visual track builder.
 *
 * Coordinates are in millimetres. A piece's position is its reference origin
 * (typically the centre of the piece). Rotation is applied around that origin.
 * Endpoints are returned in world space.
 *
 * All angles are in degrees, measured clockwise from the positive-x axis
 * (east), consistent with SVG's transform conventions.
 *
 * ── How a piece is defined ──────────────────────────────────────────────────
 * Every piece type has ONE entry in the `PIECES` registry (a
 * `Record<TrackPieceType, PieceDescriptor>`). Because the record is exhaustive,
 * the compiler forces every field for every type — there is no switch arm or
 * parallel list to forget. Each descriptor co-locates a piece's whole spec:
 *
 *   - category / label / tint / markerKind  — its metadata
 *   - endpoints(radiusMm)                    — where its rail ends are
 *   - centreLine(index, radiusMm)            — the rail a train rides to an end
 *   - railLines(radiusMm)                    — the rails it DRAWS (grooves come
 *                                              from offsetting these)
 *   - body(piece)                            — its wooden/device silhouette
 *
 * `TRACK_PIECE_TYPES`, `DEVICE_PIECE_TYPES`, `PIECE_LABELS`, `PIECE_TINT`, and
 * the `isDevicePiece` / `isWireDevice` / `pieceMarkerKind` predicates are all
 * DERIVED from the registry, so adding a piece is one entry, not a scavenger
 * hunt across this file and `ToyTable.tsx`.
 */

/**
 * The single ordered list of every piece type — the source of both the
 * `TrackPieceType` union and the registry's key set. Track pieces come first
 * (in tray order), then device pieces; the order here is the order pieces show
 * in the toybox.
 */
const ALL_PIECE_TYPES = [
  'straight',
  'curve',
  'curve-tight',
  'junction',
  'station',
  'terminus',
  'crossing',
  'ramp',
  'train',
  'gate',
  'carriage',
  'railyard',
  'vision-station',
  'turntable',
  'crane-station',
  'lift-bridge',
] as const;

export type TrackPieceType = (typeof ALL_PIECE_TYPES)[number];

/**
 * Piece types that represent devices (trains, gates, carriages) rather than
 * track topology. They sit *on* the table but contribute no endpoints or edges
 * to the compiled `Layout` — they're scanned onto the bus via `ScanBox`, not
 * compiled into the world's shape.
 *
 * Note: carriages are device pieces (no topology) but NOT wire devices — they
 * carry no RFID tag and emit nothing on the MQTT bus. Use `isWireDevice` to
 * distinguish the two. (In the registry: carriage is category `'device'`;
 * train/gate are `'wire-device'`.)
 */
export type DevicePieceType = 'train' | 'gate' | 'carriage';

/**
 * Wire-visible device types. These are the subset of device pieces that
 * announce themselves on the MQTT bus (`device_registered`) and emit events.
 * Carriages are intentionally excluded — they are physical wagons with no
 * RFID tag; the system has no awareness of them on the wire.
 */
export type WireDeviceType = 'train' | 'gate';

/**
 * The toybox tray a piece is presented in. `'track'` and `'devices'` are the
 * staples an ordinary layout uses; `'experiments'` is the shared home for the
 * speculative viability-test devices of `docs/experimental/` (001–005), kept
 * visually and organisationally apart so an operator reaching for one knows
 * they are picking up a stress-test, not a standard part. Presentation-only:
 * a piece's CATEGORY (track topology vs device) is orthogonal to its tray.
 * (004, the wedge decoupler, has no tray piece — the railyard superseded it.)
 */
export type ToyboxTray = 'track' | 'devices' | 'experiments';

/**
 * A carriage's livery. A carriage carries an intrinsic colour so a particular
 * wagon stays visually identifiable as it is shunted between trains (e.g. a
 * railyard swapping a train's leading pair). The id is semantic; the hex it
 * maps to is the renderer's business (ADR-024 §4 — devices keep solid body
 * colours, but the palette lives in `ToyTable`, never in this geometry module).
 * Absent ⇒ the default carriage livery (the same blue carriages have always
 * had), so existing layouts and screenshots are unchanged.
 */
export type CarriageColorId = 'red' | 'green' | 'amber' | 'blue' | 'purple';

/** Liveries the toybox offers, in swatch order. */
export const CARRIAGE_COLOR_IDS: readonly CarriageColorId[] = [
  'red',
  'green',
  'amber',
  'blue',
  'purple',
];

/**
 * The marker kind a track piece contributes to the layout / scan flow.
 *
 * The scan-box (in `ToyTable`) and the private layout compiler (in
 * `layout-from-pieces`) MUST agree on this mapping; both read it via
 * `pieceMarkerKind`, which now resolves through the registry, so they cannot
 * drift. Device pieces declare `markerKind: null` (they never become markers);
 * `pieceMarkerKind` maps that to `'block_boundary'` defensively so the function
 * stays total, but no caller should reach this path for a device.
 *
 * A ramp is a `block_boundary` like any straight: its two ends sit on different
 * layers, but that layer transition is editor-only metadata, never on the wire
 * (see docs/research/bridges-and-height-layers.md, Option A).
 */
export type TrackMarkerKind = 'block_boundary' | 'station_stop' | 'junction' | 'terminus';

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
  /**
   * Length override (mm) for a `straight` piece. Absent ⇒ the default 200 mm.
   * Two uses: (1) the IKEA LILLABO straight-length family (30 / 60 / 110 / 150 /
   * 200 mm) so a layout can be built from real-world straight variants, and (2)
   * the same close-a-chain-exactly role `radiusMm` plays for curves — a turnout's
   * 45° branch (a 241 mm-radius bezier) plus a 200 mm-radius curve do not tile the
   * 200 mm grid, leaving an irrational ~24 mm √2 residue when a branch rejoins the
   * main; one short straight of that exact length closes the passing loop to <1 mm
   * rather than leaving a visible kink. Mirrors the `flipped?` / `radiusMm?` idiom:
   * never written as `lengthMm: undefined` (exactOptionalPropertyTypes). Ignored
   * by non-straight pieces.
   */
  readonly lengthMm?: number;
  /**
   * Intrinsic livery for a `carriage` piece. Absent ⇒ the default carriage
   * colour. Lets the operator place distinctly-coloured wagons so an individual
   * carriage stays trackable as it is shunted between trains. Mirrors the
   * `flipped?` / `layer?` idiom: never written as `colorId: undefined`
   * (exactOptionalPropertyTypes). Ignored by non-carriage pieces.
   */
  readonly colorId?: CarriageColorId;
  /**
   * Whether a `carriage` piece carries a crate on its back. Purely cosmetic
   * and wire-invisible — cargo is to a carriage what a carriage is to a train
   * (ADR-016): a layer of physical detail the core never sees. Toggled by a
   * crane (experimental 003) working the wagon under its hook. Mirrors the
   * `flipped?` idiom: absent ⇒ empty; never written as `cargo: undefined`
   * (exactOptionalPropertyTypes). Ignored by non-carriage pieces.
   */
  readonly cargo?: boolean;
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
   * Rail-groove polylines, stroked as recessed channels. Derived uniformly (for
   * EVERY piece, no exceptions) by offsetting the piece's `railLines` ±RAIL_GAUGE
   * — so the routed grooves and the running rail can never disagree, and grooves
   * meet cleanly across a snapped joint. Empty for device pieces.
   */
  readonly grooves: ReadonlyArray<string>;
  /** Detail overlays painted on top of the body (platform, buffer, windows…). */
  readonly features: ReadonlyArray<PieceFeature>;
  readonly width: number;
  readonly height: number;
}

/** A piece body sans grooves — what a descriptor's `body()` returns. Grooves
 * are added centrally by `getPieceShape` so no piece can hand-author them. */
type PieceBody = Omit<PieceShape, 'grooves'>;

// ---------------------------------------------------------------------------
// Visual + geometry constants
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

const PLANK_CORNER = 5;

// The arc sweeps 45° about a centre, from `CURVE_ENTRY_ANGLE` to
// `CURVE_EXIT_ANGLE`. Crucially the piece *origin* is the arc midpoint, so the
// marker a curve contributes sits ON the rail — a train (or carriage) rendered
// at the marker rides the track instead of floating ~24 mm inside the bend.
const CURVE_ENTRY_ANGLE = -90;
const CURVE_EXIT_ANGLE = -45;
const CURVE_MID_ANGLE = (CURVE_ENTRY_ANGLE + CURVE_EXIT_ANGLE) / 2;

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normaliseAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Euclidean length of a vector. */
function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/**
 * Rotate a point around the origin by `angleDeg` degrees (clockwise) then
 * translate by `tx, ty`.
 */
export function transformPoint(
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

// Curve geometry, parametrised by radius `R`: arc centre at (−R/2, R) puts the
// entry endpoint at (−R/2, 0) with a due-west tangent for any R, so both the
// standard `curve` (R=200) and the `curve-tight` variant (R=100) share one
// geometry and the same 45° heading lattice.

/** Arc centre for a curve of the given radius. */
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

/** The centreline turn radius for a curve piece. An explicit `radiusMm` override
 * (a solved-radius arc) wins; otherwise the supplied default. */
function curveRadiusFor(defaultRadius: number, radiusOverride?: number): number {
  if (radiusOverride !== undefined && radiusOverride > 0) return radiusOverride;
  return defaultRadius;
}

// ---------------------------------------------------------------------------
// Centre-line sampling — the rail geometry from a piece's centre (its marker)
// out to one of its endpoints, sampled by real arc-length.
// ---------------------------------------------------------------------------

/** A point on a rail with the train's heading there. */
export interface RailPose {
  readonly x: number;
  readonly y: number;
  /** Heading (degrees clockwise from east) of travel along the rail here. */
  readonly headingDeg: number;
}

/**
 * A sampleable rail segment. `length` is the true rail length in mm (arc length
 * for curves, Euclidean for straights). `at(dist)` samples `dist` mm along it
 * from the start; heading points in the travel direction.
 */
export interface CentreLinePath {
  readonly length: number;
  at(distFromStart: number): RailPose;
}

/**
 * A straight (linear) path from `(ax, ay)` to `(bx, by)` in piece-local
 * coordinates, heading the constant A→B direction. `linearHalfPath` is the
 * common centre→endpoint case (start at the origin/marker); a general segment
 * also draws a rail that does NOT start at the marker (the terminus's buffer
 * stub).
 */
function segmentPath(ax: number, ay: number, bx: number, by: number): CentreLinePath {
  const dx = bx - ax;
  const dy = by - ay;
  const length = hypot(dx, dy);
  const headingDeg = length === 0 ? 0 : (Math.atan2(dy, dx) * 180) / Math.PI;
  const ux = length === 0 ? 0 : dx / length;
  const uy = length === 0 ? 0 : dy / length;
  return {
    length,
    at(distFromStart: number): RailPose {
      return { x: ax + ux * distFromStart, y: ay + uy * distFromStart, headingDeg };
    },
  };
}

/** A straight centre-line from the origin (marker) out to `(ex, ey)`. */
function linearHalfPath(ex: number, ey: number): CentreLinePath {
  return segmentPath(0, 0, ex, ey);
}

/** Chain several centre-lines end-to-end into one, arc length the running sum.
 *  Sampling past a sub-path's end rolls into the next; the result is a single
 *  sampleable rail the length of all of them — used to follow a train along a
 *  multi-segment route (spine → ladder leg → slot). @pure */
function concatPaths(parts: readonly CentreLinePath[]): CentreLinePath {
  const length = parts.reduce((sum, p) => sum + p.length, 0);
  return {
    length,
    at(distFromStart: number): RailPose {
      let d = Math.max(0, Math.min(length, distFromStart));
      for (const part of parts) {
        if (d <= part.length) return part.at(d);
        d -= part.length;
      }
      const last = parts.at(-1);
      return last ? last.at(last.length) : { x: 0, y: 0, headingDeg: 0 };
    },
  };
}

/** The same rail traversed the other way: position mirrored end-for-end, heading
 *  flipped 180° (so a train following it reads as travelling in reverse along the
 *  physical track). @pure */
function reversePath(path: CentreLinePath): CentreLinePath {
  return {
    length: path.length,
    at(distFromStart: number): RailPose {
      const p = path.at(path.length - Math.max(0, Math.min(path.length, distFromStart)));
      return { x: p.x, y: p.y, headingDeg: p.headingDeg + 180 };
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
    at(distFromStart: number): RailPose {
      const arcAngle = CURVE_MID_ANGLE + (sweepSign * ((distFromStart / radius) * 180)) / Math.PI;
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
    at(distFromStart: number): RailPose {
      const target = Math.max(0, Math.min(length, distFromStart));
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

/**
 * Wrap a piece-local `CentreLinePath` so its samples come out in world space,
 * applying the same mirror→rotate→translate the renderer (and `getEndpoints`)
 * use. `flip` mirrors across the local x-axis (y and heading negate) first.
 */
export function worldHalfPath(piece: TrackPiece, local: CentreLinePath): CentreLinePath {
  const flip = piece.flipped === true;
  return {
    length: local.length,
    at(distFromStart: number): RailPose {
      const pose = local.at(distFromStart);
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

// ---------------------------------------------------------------------------
// SVG path primitives
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

/**
 * Sample a piece-local rail centre-line and return the polyline that runs
 * `sign * RAIL_GAUGE` to one side of it (the routed groove). Sampling the SAME
 * path the train rides means the groove can never diverge from the running rail
 * — including through the junction branch, whose centre-line is a bezier, not a
 * straight 45° strip.
 */
function offsetGroove(rail: CentreLinePath, sign: number): string {
  const samples = Math.max(2, Math.ceil(rail.length / 8));
  let d = '';
  for (let i = 0; i <= samples; i++) {
    const pose = rail.at((i / samples) * rail.length);
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
function sweptBandAlong(rail: CentreLinePath, halfWidth: number): string {
  const samples = Math.max(2, Math.ceil(rail.length / 6));
  const forward: string[] = [];
  const backward: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const pose = rail.at((i / samples) * rail.length);
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

// ---------------------------------------------------------------------------
// Local endpoint + centre-line data (piece-local, origin = centre, facing east)
// ---------------------------------------------------------------------------

/** A piece-local endpoint, before flip/rotation/translation. */
interface LocalEndpoint {
  readonly lx: number;
  readonly ly: number;
  /** Outgoing tangent (degrees clockwise from east) in piece-local space. */
  readonly localAngle: number;
  /** +1 for the ramp's exit (one layer higher); absent ⇒ same layer. */
  readonly layerDelta?: number;
}

const STRAIGHT_ENDPOINTS: readonly LocalEndpoint[] = [
  { lx: -100, ly: 0, localAngle: 180 },
  { lx: 100, ly: 0, localAngle: 0 },
];

/** Default straight length (mm) — the standard 200 mm plank. */
export const STRAIGHT_LENGTH_MM = 200;

/** The IKEA LILLABO straight-length family (mm), for `lengthMm`-overridden
 *  straights. 200 mm is the default plank; the shorter members let a layout be
 *  built from the real-world variants and close passing loops on the grid. */
export const LILLABO_STRAIGHT_LENGTHS_MM = [30, 60, 110, 150, 200] as const;

/** Resolve a straight's length from its optional override (mm), clamped to a
 *  sane positive value; absent/non-positive ⇒ the default 200 mm. */
function straightLengthFor(lengthMm: number | undefined): number {
  return lengthMm !== undefined && lengthMm > 0 ? lengthMm : STRAIGHT_LENGTH_MM;
}

/** A straight's two endpoints for a given length: ±half along the local x-axis. */
function straightEndpoints(lengthMm: number | undefined): readonly LocalEndpoint[] {
  const half = straightLengthFor(lengthMm) / 2;
  return [
    { lx: -half, ly: 0, localAngle: 180 },
    { lx: half, ly: 0, localAngle: 0 },
  ];
}

// Reuses the straight's 200 mm footprint so snap spacing stays uniform, but its
// exit endpoint (index 1) is one layer higher: this single `layerDelta` IS the
// entire ramp/layer mechanism. Up vs down is pure orientation — edges are
// bidirectional, so a "down ramp" is just a ramp rotated 180°.
const RAMP_ENDPOINTS: readonly LocalEndpoint[] = [
  { lx: -100, ly: 0, localAngle: 180 },
  { lx: 100, ly: 0, localAngle: 0, layerDelta: 1 },
];

const STATION_ENDPOINTS: readonly LocalEndpoint[] = [
  { lx: -110, ly: 0, localAngle: 180 },
  { lx: 110, ly: 0, localAngle: 0 },
];

// Single endpoint at the open end (east). Dead-end buffer at west.
const TERMINUS_ENDPOINTS: readonly LocalEndpoint[] = [{ lx: 30, ly: 0, localAngle: 0 }];

// Two straights at 90°. Four endpoints: east, north, west, south (SVG y-down).
const CROSSING_ENDPOINTS: readonly LocalEndpoint[] = [
  { lx: 100, ly: 0, localAngle: 0 },
  { lx: 0, ly: -100, localAngle: 270 },
  { lx: -100, ly: 0, localAngle: 180 },
  { lx: 0, ly: 100, localAngle: 90 },
];

// 3 endpoints: trunk (west, index 0), through (east, index 1), branch (index 2,
// diverging at 45° with its position and outgoing tangent both down-right and
// matching the curve's chirality, so a curve continues it without a kink).
const JUNCTION_ENDPOINTS: readonly LocalEndpoint[] = [
  { lx: -100, ly: 0, localAngle: 180 },
  { lx: 100, ly: 0, localAngle: 0 },
  { lx: 100 * Math.cos(toRad(45)), ly: 100 * Math.sin(toRad(45)), localAngle: 45 },
];

/** The junction's centre→endpoint half-path for `index`. The branch leg (2) is
 * a smooth bezier from the trunk axis to the 45° endpoint so a diverting train
 * doesn't snap its heading at the marker; trunk (0) and through (1) are straight
 * collinear chords. */
function junctionCentreLine(index: number): CentreLinePath | undefined {
  const ep = JUNCTION_ENDPOINTS[index];
  if (ep === undefined) return undefined;
  if (index === 2) return bezierHalfPath(ep.lx, ep.ly, 0, ep.localAngle);
  return linearHalfPath(ep.lx, ep.ly);
}

/** Endpoints of a 45° arc of the given centreline radius. */
function curveEndpoints(radius: number): readonly LocalEndpoint[] {
  const entry = curvePointR(radius, radius, CURVE_ENTRY_ANGLE);
  const exit = curvePointR(radius, radius, CURVE_EXIT_ANGLE);
  return [
    { lx: entry.x, ly: entry.y, localAngle: 180 },
    { lx: exit.x, ly: exit.y, localAngle: 45 },
  ];
}

/** The `endpoints` + `centreLine` pair for a piece whose every leg is a straight
 * chord from the marker to an endpoint (straight, station, ramp, crossing). */
function linearLegs(eps: readonly LocalEndpoint[]): {
  endpoints: () => readonly LocalEndpoint[];
  centreLine: (index: number) => CentreLinePath | undefined;
} {
  return {
    endpoints: () => eps,
    centreLine: (index: number) => {
      const e = eps[index];
      return e === undefined ? undefined : linearHalfPath(e.lx, e.ly);
    },
  };
}

// ---------------------------------------------------------------------------
// Body builders (piece-local coordinates, origin at piece centre). Each returns
// the silhouette + features WITHOUT grooves; getPieceShape adds grooves.
// ---------------------------------------------------------------------------

/** A straight wooden plank of length `len`, centred on the origin. `features`
 * overlay extra detail (e.g. the ramp chevrons). */
function plankBody(len: number, features: ReadonlyArray<PieceFeature>): PieceBody {
  const half = len / 2;
  return {
    svgPath: roundRect(-half, -PLANK_HALF_WIDTH, len, PLANK_HALF_WIDTH * 2, PLANK_CORNER),
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

function curveBody(radius: number): PieceBody {
  // The wooden band of the 45° arc, drawn on exactly the geometry the endpoints
  // use, so the plank connects its own ends instead of floating away from them.
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
    features: [],
    width: (180 * radius) / CURVE_RADIUS_MM,
    height: (90 * radius) / CURVE_RADIUS_MM,
  };
}

function junctionBody(): PieceBody {
  // A wooden Y: the through plank runs west↔east; the branch plank SWEEPS along
  // the same bezier centre-line its grooves (and a diverting train) follow, so
  // the branch wood curves WITH its rails. With no hard outline + one wood fill,
  // the through plank and the branch band read as a single forked piece.
  const ph = PLANK_HALF_WIDTH;
  const through = roundRect(-100, -ph, 200, ph * 2, PLANK_CORNER);
  const branchLocal = junctionCentreLine(2);
  const branch = branchLocal === undefined ? '' : sweptBandAlong(branchLocal, ph);
  const branchEnd = JUNCTION_ENDPOINTS[2];
  const ey = branchEnd?.ly ?? 70.71;
  return {
    svgPath: `${through} ${branch}`,
    features: [],
    width: 200,
    height: ph + ey + ph,
  };
}

function stationBody(): PieceBody {
  // A 220 mm plank with a raised platform deck along its north (upper) edge.
  const ph = PLANK_HALF_WIDTH;
  const platformTop = -(ph + 22);
  const platform = roundRect(-52, platformTop, 104, 24, 4);
  // A thin platform-edge line gives the deck a lip facing the rail.
  const lip: PieceFeature = { role: 'line', width: 2, d: `M -50 ${-ph - 1} H 50` };
  return {
    svgPath: roundRect(-110, -ph, 220, ph * 2, PLANK_CORNER),
    features: [{ role: 'platform', d: platform }, lip],
    width: 220,
    height: ph - platformTop,
  };
}

function terminusBody(): PieceBody {
  // A short plank with a chunky wooden buffer-stop at the dead end (west); the
  // open end is east. Two metal bumper pads face the incoming train.
  const ph = PLANK_HALF_WIDTH;
  const buffer = roundRect(-38, -(ph + 3), 12, (ph + 3) * 2, 3);
  return {
    svgPath: roundRect(-30, -ph, 60, ph * 2, PLANK_CORNER),
    features: [
      { role: 'dark-wood', d: buffer },
      { role: 'metal', d: circle(-24, -RAIL_GAUGE, 2.6) },
      { role: 'metal', d: circle(-24, RAIL_GAUGE, 2.6) },
    ],
    width: 60,
    height: (ph + 3) * 2,
  };
}

function crossingBody(): PieceBody {
  // Two 200 mm planks crossing at 90°. Both rounded rects are wound the same
  // way, so the nonzero fill unions them into a plus with no hole at the centre.
  const ph = PLANK_HALF_WIDTH;
  const ew = roundRect(-100, -ph, 200, ph * 2, PLANK_CORNER);
  const ns = roundRect(-ph, -100, ph * 2, 200, PLANK_CORNER);
  return {
    svgPath: `${ew} ${ns}`,
    features: [],
    width: 200,
    height: 200,
  };
}

function trainBody(): PieceBody {
  // A friendly top-down loco, nose to the east. Rounded hull tapering to the
  // nose, a dark boiler/roof panel, a windscreen, a funnel and a headlamp.
  const body = 'M -40 -7 Q -40 -13 -34 -13 H 24 L 40 -5 L 40 5 L 24 13 H -34 Q -40 13 -40 7 Z';
  return {
    svgPath: body,
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

function gateBody(): PieceBody {
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

function carriageBody(): PieceBody {
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
    features: [{ role: 'dark-wood', d: roundRect(-26, -ph, 52, 4, 2) }, ...windows],
    width: w,
    height: ph * 2,
  };
}

// ---------------------------------------------------------------------------
// Railyard: a self-contained PASS-THROUGH yard, rendered as ordinary wooden
// track (ADR-024). A single running line (the spine) runs west→east — its two
// endpoints are the yard's single input and single output. Off that spine, a
// ladder of normal-looking turnouts leads onto six pass-through slots (three
// each side) and, at the far end, a mirror ladder leads them back onto the
// spine. Every rail is real wood (planks + swept bands) with routed grooves.
//
// A 3D-printer-style XY gantry (drawn by ToyTable) straddles the yard: its
// foundations sit OUTSIDE the outer slots, a bridge rolls along them, and a
// crane head crosses the bridge so it can reach OVER any slot to work a
// coupling. The gantry geometry it needs is exported below.
// ---------------------------------------------------------------------------

/** Half the spine length (x): west input endpoint → east output endpoint. 600 so
 *  the yard spans 1200 mm end-to-end — six straights — wide enough that a whole
 *  train (loco + a four-wagon rake, ~330 mm) sits INSIDE one slot AND there is a
 *  real headshunt: the lead east of the outermost tap is long enough for the
 *  train to pull fully clear of a slot before reversing into another. Still a
 *  multiple of the 200 mm grid so the demo loop splices it in and closes (the
 *  loop gains matching straights top + bottom). */
export const RAILYARD_HALF_LENGTH_MM = 600;
/** The six slots, at these local-y offsets (three each side of the spine).
 *  Spaced 48 mm apart (double the original) so a 26 mm-tall carriage sitting in
 *  one slot clears its neighbours; the inner pair sits ±36 so the centre spine
 *  keeps a clear margin. */
export const RAILYARD_SLOT_YS: readonly number[] = [-132, -84, -36, 36, 84, 132];
/** x of the slot mouths: slots run from -RAILYARD_SLOT_HALF_X to +. 200 each side
 *  → 400 mm slots, long enough to hold a whole train (loco + rake) with margin,
 *  plus run to spare for each ladder leg's gentle S-bend. */
const RAILYARD_SLOT_HALF_X = 200;
/** Plank half-width for the yard's (narrower) tracks. */
const RAILYARD_PLANK_HW = 7;
/** Where the three west turnouts tap off the spine (outer slot peels off first,
 *  furthest from the slot mouths, so the ladder legs never cross). Indexed by
 *  rank-from-centre: inner pair, mid pair, outer pair. Sit OUTSIDE the slot
 *  mouths (±200) and spread wide so every ladder leg is a long, gentle crossover
 *  — elongated to match the wider yard. Mirrored east. */
const RAILYARD_LADDER_XS: readonly number[] = [264, 310, 350];

/** Side-rail (gantry foundation) offset: just OUTSIDE the outer slots. */
export const RAILYARD_RAIL_Y = 152;
/** How far along the spine the gantry bridge may travel (inside the endpoints). */
export const RAILYARD_GANTRY_X = 560;
/** Outer bound of the crane head's reach across the bridge (over the slots). */
export const RAILYARD_HEAD_Y = 138;
/** Drawing bounds (selection glow / body box): the gantry footprint. */
export const RAILYARD_FRAME_TOP_MM = -RAILYARD_RAIL_Y - 10;
export const RAILYARD_FRAME_BOT_MM = RAILYARD_RAIL_Y + 10;

const RAILYARD_ENDPOINTS: readonly LocalEndpoint[] = [
  { lx: -RAILYARD_HALF_LENGTH_MM, ly: 0, localAngle: 180 },
  { lx: RAILYARD_HALF_LENGTH_MM, ly: 0, localAngle: 0 },
];

/** A smooth ladder leg from a turnout on the spine at `(sx, 0)` out to a slot
 *  mouth at `(ex, ey)`, leaving and arriving parallel to the rails (an S-bend,
 *  like a crossover) so the wood and its grooves flow rather than kink. The
 *  tangents point along the tap→mouth direction (east legs run back west toward
 *  the output), so the bezier never folds into a hairpin. */
function railyardLeg(sx: number, ex: number, ey: number): CentreLinePath {
  const along = ex >= sx ? 0 : 180; // heading from tap toward the slot mouth
  const base = bezierHalfPath(ex - sx, ey, along, along);
  return {
    length: base.length,
    at(d: number): RailPose {
      const p = base.at(d);
      return { x: p.x + sx, y: p.y, headingDeg: p.headingDeg };
    },
  };
}

/** The west + east ladder legs feeding every slot (12 in all). Rank `r`
 *  (0=inner … 2=outer) taps the spine at ∓RAILYARD_LADDER_XS[r]. */
function railyardLegs(): CentreLinePath[] {
  const legs: CentreLinePath[] = [];
  for (const [r, x] of RAILYARD_LADDER_XS.entries()) {
    // Rank 0 taps nearest the mouths and feeds the INNERMOST slot (y=-12); the
    // furthest tap feeds the outermost (y=-60). Mapping rank→slot this way keeps
    // the ladder legs from crossing. SLOT_YS top trio is [-60,-36,-12], so the
    // inner-first order is its reverse.
    const top = RAILYARD_SLOT_YS[2 - r] ?? 0; // r:0→-12, 1→-36, 2→-60
    const bot = -top;
    legs.push(railyardLeg(-x, -RAILYARD_SLOT_HALF_X, top)); // west → top slot mouth
    legs.push(railyardLeg(-x, -RAILYARD_SLOT_HALF_X, bot)); // west → bottom slot mouth
    legs.push(railyardLeg(x, RAILYARD_SLOT_HALF_X, top)); // east → top slot mouth
    legs.push(railyardLeg(x, RAILYARD_SLOT_HALF_X, bot)); // east → bottom slot mouth
  }
  return legs;
}

/** The west ladder tap (spine x, always negative — the throat is the west end)
 *  that feeds the slot at local `slotY`. Inner slots (±36) tap nearest the
 *  mouths, outer (±132) furthest, mirroring `railyardLegs`. */
function railyardTapX(slotY: number): number {
  const rank = [36, 84, 132].indexOf(Math.abs(slotY)); // 0 inner … 2 outer
  return -(RAILYARD_LADDER_XS[rank < 0 ? 0 : rank] ?? RAILYARD_LADDER_XS[0] ?? 174);
}

/** The east ladder tap (mirror of the west tap). */
function railyardEastTapX(slotY: number): number {
  return -railyardTapX(slotY);
}

/** The east ladder leg as an on-rail path from the spine tap to the slot's east
 *  mouth (heads west, tap→mouth). The interior journey enters/exits slots from
 *  the east lead, so only the east legs are needed for it. */
function railyardEastLeg(slotY: number): CentreLinePath {
  return railyardLeg(railyardEastTapX(slotY), RAILYARD_SLOT_HALF_X, slotY);
}

/**
 * The interior shunting journey (docs/spec/railyard-shunting-choreography.md) as
 * directed, on-rail phase paths in the yard's local frame. The yard's throat is
 * its EXIT endpoint (+HALF) — the train transits the spine and suspends THERE
 * (see the railyard `centreLine`), so the journey starts and ends at the throat:
 * no teleport handing off to/from the main line, and no pull-onto-the-lead before
 * entering or return to the centre. Each path is a single physical direction and
 * consecutive paths share the loco's endpoint, so the loco moves continuously:
 *
 *   enter        reverse straight off the throat into the free entry slot, rest;
 *   pullClear    pull forward back toward the throat lead (leaving the shed cut);
 *   backToSpares reverse into the spares slot until the rake couples;
 *   settle       pull forward to the stable rest, rake contained in the slot;
 *   exit         pull forward straight out to the throat, where core reclaims it.
 *
 * The crane only decouples; it is not part of these paths.
 */
export interface RailyardJourney {
  readonly enter: CentreLinePath;
  readonly pullClear: CentreLinePath;
  readonly backToSpares: CentreLinePath;
  readonly settle: CentreLinePath;
  readonly exit: CentreLinePath;
  /** Local pose where the shed cut rests (east end of the dropped pair, in the
   *  entry slot) and where the spare cut rests (east end, in the spares slot). */
  readonly shedPose: RailPose;
  readonly sparesPose: RailPose;
  /** Local pose of the COUPLING the crane splits — between the kept front of the
   *  rake and the shed rear cut (where the crane lowers to decouple). */
  readonly couplingPose: RailPose;
}

/** The throat (exit endpoint = where the train suspends), the headshunt lead just
 *  inside it, loco rest (far end of a slot, rake contained), where the loco sits
 *  when the rake couples deep, and where the spare cut rests — all local x (mm).
 *  Tuned for the 400 mm slots + ~330 mm rake in the 1200 mm yard. */
const RAILYARD_THROAT_X = RAILYARD_HALF_LENGTH_MM;
const RAILYARD_LEAD_X = RAILYARD_HALF_LENGTH_MM - 30;
const RAILYARD_REST_X = RAILYARD_SLOT_HALF_X - 40;
const RAILYARD_COUPLE_X = 76;
const RAILYARD_SPARES_X = -60;
/** East end of the shed cut as it rests in the entry slot (the rear pair, three
 *  carriage-spacings behind the loco's rest), and the coupling between the kept
 *  front pair and that shed rear pair (where the crane lowers to split). */
const RAILYARD_SHED_X = RAILYARD_REST_X - 3 * 68;
const RAILYARD_COUPLING_X = RAILYARD_REST_X - 2.5 * 68;

/** Reverse a train into a slot from the lead: spine to the slot's east tap, the
 *  east leg to the mouth, then along the slot to `toX`. Heads west throughout. */
function railyardReverseIntoSlot(fromX: number, slotY: number, toX: number): CentreLinePath {
  return concatPaths([
    segmentPath(fromX, 0, railyardEastTapX(slotY), 0),
    railyardEastLeg(slotY),
    segmentPath(RAILYARD_SLOT_HALF_X, slotY, toX, slotY),
  ]);
}

/** Pull a train forward out of a slot onto the lead: along the slot to the east
 *  mouth, out the east leg to the tap, then up the spine to `toX`. Heads east. */
function railyardPullToLead(fromX: number, slotY: number, toX: number): CentreLinePath {
  return concatPaths([
    segmentPath(fromX, slotY, RAILYARD_SLOT_HALF_X, slotY),
    reversePath(railyardEastLeg(slotY)),
    segmentPath(railyardEastTapX(slotY), 0, toX, 0),
  ]);
}

export function railyardInteriorJourney(entrySlotY: number, sparesSlotY: number): RailyardJourney {
  return {
    // Reverse straight off the throat into the entry slot — no lead-out.
    enter: railyardReverseIntoSlot(RAILYARD_THROAT_X, entrySlotY, RAILYARD_REST_X),
    pullClear: railyardPullToLead(RAILYARD_REST_X, entrySlotY, RAILYARD_LEAD_X),
    backToSpares: railyardReverseIntoSlot(RAILYARD_LEAD_X, sparesSlotY, RAILYARD_COUPLE_X),
    settle: segmentPath(RAILYARD_COUPLE_X, sparesSlotY, RAILYARD_REST_X, sparesSlotY),
    // Pull forward straight out to the throat to leave — no return to the centre.
    exit: railyardPullToLead(RAILYARD_REST_X, sparesSlotY, RAILYARD_THROAT_X),
    shedPose: { x: RAILYARD_SHED_X, y: entrySlotY, headingDeg: 0 },
    sparesPose: { x: RAILYARD_SPARES_X, y: sparesSlotY, headingDeg: 0 },
    couplingPose: { x: RAILYARD_COUPLING_X, y: entrySlotY, headingDeg: 0 },
  };
}

/** Every rail a train could ride in the yard: the spine, the six slots, and the
 *  ladder legs that connect them — grooves are derived from these. */
function railyardRailLines(): CentreLinePath[] {
  const lines: CentreLinePath[] = [
    segmentPath(-RAILYARD_HALF_LENGTH_MM, 0, RAILYARD_HALF_LENGTH_MM, 0), // spine
  ];
  for (const sy of RAILYARD_SLOT_YS) {
    lines.push(segmentPath(-RAILYARD_SLOT_HALF_X, sy, RAILYARD_SLOT_HALF_X, sy));
  }
  lines.push(...railyardLegs());
  return lines;
}

function railyardBody(): PieceBody {
  // Wooden track: a plank for the spine and each slot, plus a band swept along
  // each ladder leg, so the wood follows the rails exactly (ADR-024).
  const ph = RAILYARD_PLANK_HW;
  const planks: string[] = [
    roundRect(-RAILYARD_HALF_LENGTH_MM, -ph, RAILYARD_HALF_LENGTH_MM * 2, ph * 2, PLANK_CORNER),
  ];
  for (const sy of RAILYARD_SLOT_YS) {
    planks.push(
      roundRect(-RAILYARD_SLOT_HALF_X, sy - ph, RAILYARD_SLOT_HALF_X * 2, ph * 2, PLANK_CORNER),
    );
  }
  for (const leg of railyardLegs()) planks.push(sweptBandAlong(leg, ph));
  return {
    svgPath: planks.join(' '),
    features: [],
    width: RAILYARD_HALF_LENGTH_MM * 2,
    height: RAILYARD_FRAME_BOT_MM - RAILYARD_FRAME_TOP_MM,
  };
}

// ---------------------------------------------------------------------------
// Experimental pieces (docs/experimental/ 001–005) — the "Experiments" tray.
// Each is the toy-box element of a speculative viability-test device: the
// geometry here is the agreed piece shape; the wire behaviour each one proves
// lives in the scan flow (ToyTable) and the in-browser sim (ToyHardware).
// ---------------------------------------------------------------------------

/** Local position of the vision station's detection LED (on the sensor mast,
 * near the rail). The static body draws its dark metal housing; the renderer
 * lights a `pop` dot here while a train is under the sensor — the device's
 * only "motion" (experimental 001 is defined by stillness). */
export const VISION_LED = { x: 62.5, y: -16 } as const;

/** Range (mm, from the piece origin) within which a train counts as "under
 * the sensor" — being measured — so the LED lights. Visual only. */
export const VISION_SENSOR_RANGE_MM = 55;

/**
 * The two sensing reference points the vision station OWNS, a known baseline
 * apart, and the camera footprint between them — the honest two-marker speed
 * rig of ADR-030 §5. Both reference points lie within the station's own 220 mm
 * plank (local x along the rail axis), so the piece genuinely carries both; the
 * baseline is fixed by the device, not derived from the layout. A passing
 * train's HEAD crossing the two points a fixed distance apart yields its speed
 * (baseline ÷ crossing interval); the camera at the centre integrates the dwell
 * the train's body covers it; length = speed × dwell. No train self-report, no
 * consist read. */
export const VISION_MARKER_A_LX = -70;
export const VISION_MARKER_B_LX = 70;
/** Fixed baseline (mm) between the station's two reference points (their local
 * x separation). The honest speed divisor — internally set, never the layout's. */
export const VISION_BASELINE_MM = VISION_MARKER_B_LX - VISION_MARKER_A_LX;
/** Capture radius (mm) of the camera footprint patch at the station centre. The
 * dwell-derived span overruns the true span by this at each end — the bounded
 * over-read a real fixed camera lives with. */
export const VISION_FOOTPRINT_RADIUS_MM = 12;

function visionStationBody(): PieceBody {
  // An ordinary station plank + platform (shifted west to make room), with the
  // one manufactured addition: a thin grey camera mast beside the platform — a
  // lens fitting at the top, the detection LED housing near the rail.
  const ph = PLANK_HALF_WIDTH;
  const platformTop = -(ph + 22);
  return {
    svgPath: roundRect(-110, -ph, 220, ph * 2, PLANK_CORNER),
    features: [
      { role: 'platform', d: roundRect(-60, platformTop, 104, 24, 4) },
      { role: 'line', width: 2, d: `M -58 ${-ph - 1} H 46` },
      { role: 'metal', d: roundRect(60, -34, 5, 20, 2) },
      { role: 'glass', d: circle(62.5, -30, 3) },
      { role: 'metal', d: circle(VISION_LED.x, VISION_LED.y, 2.8) },
    ],
    width: 220,
    height: ph - platformTop,
  };
}

/** Radius of the turntable's circular body. Endpoints sit ON the rim, so the
 * disc spans 200 mm — the footprint of a junction. */
export const TURNTABLE_RADIUS_MM = 100;

/** The deck positions a turntable confirms — one per exit stub, in endpoint
 * order [1, 2, 3]. Three position strings on ONE junction marker is the whole
 * point of experimental 002: the switch seam is already N-way. */
export type TurntablePosition = 'stub-a' | 'stub-b' | 'stub-c';
export const TURNTABLE_POSITIONS: readonly TurntablePosition[] = ['stub-a', 'stub-b', 'stub-c'];

/** Deck angle (deg, about the disc centre) for each confirmed position — the
 * branch choice as a visible angle. */
export const TURNTABLE_POSITION_ANGLE_DEG: Record<TurntablePosition, number> = {
  'stub-a': 0,
  'stub-b': 45,
  'stub-c': -45,
};

/** Length of the fixed routed stubs at each rim exit. */
const TURNTABLE_STUB_LEN = 22;

// Trunk (west, index 0) + three exit stubs: east, and ±45° — all on the 45°
// heading lattice so the disc snaps like any other piece.
const TURNTABLE_ENDPOINTS: readonly LocalEndpoint[] = [
  { lx: -TURNTABLE_RADIUS_MM, ly: 0, localAngle: 180 },
  { lx: TURNTABLE_RADIUS_MM, ly: 0, localAngle: 0 },
  {
    lx: TURNTABLE_RADIUS_MM * Math.cos(toRad(45)),
    ly: TURNTABLE_RADIUS_MM * Math.sin(toRad(45)),
    localAngle: 45,
  },
  {
    lx: TURNTABLE_RADIUS_MM * Math.cos(toRad(45)),
    ly: -TURNTABLE_RADIUS_MM * Math.sin(toRad(45)),
    localAngle: -45,
  },
];

/** Trunk and east stub are straight chords through the centre; the ±45° stubs
 * are smooth beziers like the junction branch, so a diverting train turns
 * through the disc instead of snapping its heading at the marker. */
function turntableCentreLine(index: number): CentreLinePath | undefined {
  const ep = TURNTABLE_ENDPOINTS[index];
  if (ep === undefined) return undefined;
  if (index >= 2) return bezierHalfPath(ep.lx, ep.ly, 0, ep.localAngle);
  return linearHalfPath(ep.lx, ep.ly);
}

/** Only the short FIXED rim stubs are routed into the static body. The
 * full-diameter bridge grooves belong to the ROTATING deck (`turntableDeck`),
 * drawn live by the renderer at the confirmed switch angle — the one piece
 * whose decoration moves relative to its body. */
function turntableRailLines(): readonly CentreLinePath[] {
  return TURNTABLE_ENDPOINTS.map((ep) => {
    const ux = Math.cos(toRad(ep.localAngle));
    const uy = Math.sin(toRad(ep.localAngle));
    return segmentPath(
      ep.lx - ux * TURNTABLE_STUB_LEN,
      ep.ly - uy * TURNTABLE_STUB_LEN,
      ep.lx,
      ep.ly,
    );
  });
}

/** Radius of the recessed PIT the bridge swings inside — everything inside
 * this reads a level below the beech surround, like a real turntable well. */
const TURNTABLE_PIT_R = 86;

/** Mid-radius of the steel ring rail the bridge ends ride on. Real pits run a
 * support rail around the floor so the bridge is carried at both ends, not
 * only at the pivot; the visual borrows that. */
const TURNTABLE_RING_R = 78;

/** A filled annular band from `rInner` to `rOuter`, sweeping `startDeg` →
 * `endDeg` clockwise — the ring-rail arcs (real pits split the ring into
 * arcs; ours also keeps the rail clear of the four exits). */
function arcBand(rOuter: number, rInner: number, startDeg: number, endDeg: number): string {
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const at = (r: number, deg: number): string =>
    `${fmt(r * Math.cos(toRad(deg)))} ${fmt(r * Math.sin(toRad(deg)))}`;
  return (
    `M ${at(rOuter, startDeg)} A ${fmt(rOuter)} ${fmt(rOuter)} 0 ${large} 1 ${at(rOuter, endDeg)} ` +
    `L ${at(rInner, endDeg)} A ${fmt(rInner)} ${fmt(rInner)} 0 ${large} 0 ${at(rInner, startDeg)} Z`
  );
}

function turntableBody(): PieceBody {
  // The BRIO-style read (cf. the 33361 mechanical turntable): a beech
  // SURROUND ring, a dark RECESSED PIT the bridge swings inside, a steel
  // ring rail around the pit floor carrying the bridge ends (two arcs, kept
  // clear of the four exits), and a red operating knob on the surround —
  // the hand-cranked control every wooden turntable has.
  const r = TURNTABLE_RADIUS_MM;
  const knob = {
    x: 93 * Math.cos(toRad(112)),
    y: 93 * Math.sin(toRad(112)),
  };
  return {
    svgPath: circle(0, 0, r),
    features: [
      { role: 'dark-wood', d: circle(0, 0, TURNTABLE_PIT_R) },
      { role: 'metal', d: arcBand(TURNTABLE_RING_R + 1.5, TURNTABLE_RING_R - 1.5, 60, 160) },
      { role: 'metal', d: arcBand(TURNTABLE_RING_R + 1.5, TURNTABLE_RING_R - 1.5, 200, 300) },
      { role: 'metal', d: circle(knob.x, knob.y, 5) },
      { role: 'danger', d: circle(knob.x, knob.y, 3.2) },
    ],
    width: r * 2,
    height: r * 2,
  };
}

/**
 * The turntable's rotating bridge deck, in piece-local coordinates: a wooden
 * bridge spanning the pit wall to wall, with its own twin grooves, metal end
 * carriages riding the ring rail, and the pivot hub. The renderer rotates
 * this whole sub-shape about the origin to the confirmed switch position's
 * angle (`TURNTABLE_POSITION_ANGLE_DEG`) — it is never part of the static
 * body, so the grooves a train sees always match the deck angle.
 */
export function turntableDeck(): {
  readonly svgPath: string;
  readonly grooves: ReadonlyArray<string>;
  readonly features: ReadonlyArray<PieceFeature>;
} {
  const len = TURNTABLE_PIT_R;
  const rail = segmentPath(-len, 0, len, 0);
  return {
    svgPath: roundRect(-len, -PLANK_HALF_WIDTH, len * 2, PLANK_HALF_WIDTH * 2, PLANK_CORNER),
    grooves: [offsetGroove(rail, 1), offsetGroove(rail, -1)],
    features: [
      // End carriages — the wheeled fittings riding the ring rail.
      { role: 'metal', d: roundRect(-len + 2, -9, 6, 18, 2) },
      { role: 'metal', d: roundRect(len - 8, -9, 6, 18, 2) },
      // Pivot hub at the centre.
      { role: 'metal', d: circle(0, 0, 6) },
      { role: 'pop', d: circle(0, 0, 2.4) },
    ],
  };
}

/** Local x of the crane's gantry/hook centre line — the reach test and the
 * crate work all happen under the beam. */
export const CRANE_GANTRY_X_MM = 45;

/** World reach (mm) within which a wagon counts as under the hook. */
export const CRANE_REACH_MM = 60;

/** Crates a freshly placed crane has waiting on its trackside stack. */
export const CRANE_INITIAL_CRATES = 3;

/** Local y where the cantilevered beam ends, south of the track, over the
 * stack — the trolley's rest position and the crates' home. */
export const CRANE_BEAM_SOUTH_Y_MM = 46;

/** Trolley rest offset (local y): parked over the stack at the beam's south
 * end. The renderer translates the trolley between here and y=0 (over the
 * rail) — the slide along the cross-beam the design doc describes. */
export const CRANE_TROLLEY_REST_Y_MM = 34;

/** Stack slot centres (local coords) under the beam's south end, filled
 * bottom row first — also the stack's capacity. One crate per held slot. */
export const CRANE_STACK_SLOTS: ReadonlyArray<{ readonly x: number; readonly y: number }> = [
  { x: CRANE_GANTRY_X_MM - 11, y: 34 },
  { x: CRANE_GANTRY_X_MM + 11, y: 34 },
  { x: CRANE_GANTRY_X_MM - 11, y: 45 },
  { x: CRANE_GANTRY_X_MM + 11, y: 45 },
  { x: CRANE_GANTRY_X_MM - 11, y: 56 },
  { x: CRANE_GANTRY_X_MM + 11, y: 56 },
];

/** One trackside crate, centred on a stack slot. */
export function craneCratePath(cx: number, cy: number): string {
  return roundRect(cx - 4.5, cy - 4.5, 9, 9, 1.5);
}

/** The crate riding a laden wagon's back, in carriage-local coordinates. */
export function carriageCratePath(): string {
  return roundRect(-6, -6, 12, 12, 2);
}

/**
 * The crane's TROLLEY — the travelling arm: a grey carriage astride the beam
 * with a bright hook hanging from it. Drawn at y=0 (over the rail); the
 * renderer translates the whole sub-shape down the beam to
 * `CRANE_TROLLEY_REST_Y_MM` (over the stack) and back — sliding out over a
 * wagon whenever one is under the gantry. Local coordinates.
 */
export function craneTrolley(): ReadonlyArray<PieceFeature> {
  const gx = CRANE_GANTRY_X_MM;
  return [
    // The trolley carriage astride the beam, wider than the beam so it reads
    // as riding it.
    { role: 'metal', d: roundRect(gx - 8, -6.5, 16, 13, 2.5) },
    { role: 'dark-wood', d: roundRect(gx - 5, -4, 10, 8, 1.5) },
    // The hook block slung under the carriage, with its bright sheave.
    { role: 'metal', d: roundRect(gx - 3, 4.5, 6, 5, 1.5) },
    { role: 'pop', d: circle(gx, 7, 2.2) },
  ];
}

function craneStationBody(): PieceBody {
  // A station plank with the platform shifted west; a manufactured grey
  // gantry straddles the track to the east (experimental 003): two uprights,
  // and a cross-beam that runs over the rails and CANTILEVERS south past the
  // track to end over the crate stack — the runway the trolley travels. The
  // trolley (the arm) and the stack are moving parts the renderer draws live.
  const ph = PLANK_HALF_WIDTH;
  const platformTop = -(ph + 22);
  const gx = CRANE_GANTRY_X_MM;
  const beamTop = -ph - 13;
  return {
    svgPath: roundRect(-110, -ph, 220, ph * 2, PLANK_CORNER),
    features: [
      { role: 'platform', d: roundRect(-95, platformTop, 80, 24, 4) },
      { role: 'line', width: 2, d: `M -93 ${-ph - 1} H -17` },
      // Uprights either side of the track.
      { role: 'metal', d: roundRect(gx - 8, beamTop, 16, 10, 2) },
      { role: 'metal', d: roundRect(gx - 8, ph + 3, 16, 10, 2) },
      // The beam: across the track and cantilevered south over the stack.
      { role: 'metal', d: roundRect(gx - 3.5, beamTop, 7, CRANE_BEAM_SOUTH_Y_MM - beamTop, 2) },
      // Beam end stop over the stack.
      { role: 'dark-wood', d: roundRect(gx - 5, CRANE_BEAM_SOUTH_Y_MM - 3, 10, 4, 1.5) },
    ],
    width: 220,
    // From the platform's north edge down to the bottom crate row.
    height: 60.5 - platformTop,
  };
}

/** Half-length of the lift bridge's hinged span. The fixed approaches end
 * 4 mm short of it, so the deck visibly PARTS from its neighbours. */
export const LIFT_BRIDGE_SPAN_HALF_MM = 68;
const LIFT_BRIDGE_APPROACH_LEN = 28;

/** Local pivot the raised span hinges about (the deck's west end, where the
 * metal pivot fitting sits). */
export const LIFT_BRIDGE_PIVOT = { x: -LIFT_BRIDGE_SPAN_HALF_MM, y: 0 } as const;

/**
 * How much the raised span FORESHORTENS toward its hinge, as a fraction of
 * its length. Seen from above, a bascule leaf tilting up doesn't swing or
 * translate — its plan-view length compresses toward the pivot (cos of the
 * lift angle; 0.45 ≈ a deck lifted past 60°), revealing the gap beyond its
 * free end. The renderer applies this as a scale about `LIFT_BRIDGE_PIVOT`.
 */
export const LIFT_BRIDGE_FORESHORTEN = 0.45;

/** The deck's UNDERSIDE end plate — the dark edge face that becomes visible
 * at the free end once the leaf tilts up toward the viewer. The renderer
 * fades it in while raised; invisible when the deck lies flat. */
export function liftBridgeEndPlate(): string {
  return roundRect(LIFT_BRIDGE_SPAN_HALF_MM - 5, -PLANK_HALF_WIDTH, 5, PLANK_HALF_WIDTH * 2, 2);
}

function liftBridgeBody(): PieceBody {
  // Only the two FIXED approach stubs: the hinged span itself is a separate
  // sub-shape (`liftBridgeSpan`) the renderer draws over the gap and tilts
  // when raised. It is track, so everything stays wooden (ADR-024 §4).
  const ph = PLANK_HALF_WIDTH;
  const west = roundRect(-100, -ph, LIFT_BRIDGE_APPROACH_LEN, ph * 2, PLANK_CORNER);
  const east = roundRect(
    100 - LIFT_BRIDGE_APPROACH_LEN,
    -ph,
    LIFT_BRIDGE_APPROACH_LEN,
    ph * 2,
    PLANK_CORNER,
  );
  return {
    svgPath: `${west} ${east}`,
    features: [],
    width: 200,
    height: ph * 2,
  };
}

/**
 * The lift bridge's hinged SPAN, in piece-local coordinates: a beech deck with
 * its own grooves and a metal pivot fitting at the west end. The renderer
 * draws it across the gap when seated and, while raised, foreshortens it
 * toward `LIFT_BRIDGE_PIVOT` (`LIFT_BRIDGE_FORESHORTEN`) with the underside
 * end plate fading in — never part of the static body, so the rail visibly
 * breaks when the track "is not there".
 */
export function liftBridgeSpan(): {
  readonly svgPath: string;
  readonly grooves: ReadonlyArray<string>;
  readonly features: ReadonlyArray<PieceFeature>;
} {
  const half = LIFT_BRIDGE_SPAN_HALF_MM;
  const rail = segmentPath(-half, 0, half, 0);
  return {
    svgPath: roundRect(-half, -PLANK_HALF_WIDTH, half * 2, PLANK_HALF_WIDTH * 2, PLANK_CORNER),
    grooves: [offsetGroove(rail, 1), offsetGroove(rail, -1)],
    features: [{ role: 'metal', d: circle(-half + 7, 0, 3.5) }],
  };
}

/** The dark void revealed under a raised span — the renderer fades it in
 * beneath the tilting deck so the missing rail reads as a real gap. */
export function liftBridgeGap(): string {
  return roundRect(
    -LIFT_BRIDGE_SPAN_HALF_MM,
    -PLANK_HALF_WIDTH + 3,
    LIFT_BRIDGE_SPAN_HALF_MM * 2,
    PLANK_HALF_WIDTH * 2 - 6,
    3,
  );
}

// ---------------------------------------------------------------------------
// The piece registry — one self-contained descriptor per type.
// ---------------------------------------------------------------------------

/**
 * `'track'` pieces contribute topology (endpoints/markers). `'wire-device'`
 * pieces (train, gate) announce on the bus and emit events. `'device'` pieces
 * (carriage) sit on the table but are invisible to the wire and the graph.
 */
type PieceCategory = 'track' | 'device' | 'wire-device';

interface PieceDescriptor {
  readonly category: PieceCategory;
  /** Which toybox tray presents this piece (see `ToyboxTray`). */
  readonly tray: ToyboxTray;
  readonly label: string;
  /** Warm wood wash, or null for plain beech / devices. See PIECE_TINT. */
  readonly tint: string | null;
  /** Marker kind contributed to the layout, or null for non-marker (device) pieces. */
  readonly markerKind: TrackMarkerKind | null;
  /** Local endpoints, canonical index order (transformed to world by getEndpoints).
   *  `radiusMm` overrides a curve's arc; `lengthMm` overrides a straight's length. */
  endpoints(radiusMm?: number, lengthMm?: number): readonly LocalEndpoint[];
  /** Centre→endpoint half-path for `index` (the rail a train RIDES). undefined out of range. */
  centreLine(index: number, radiusMm?: number, lengthMm?: number): CentreLinePath | undefined;
  /** The rails a piece DRAWS — offset ±RAIL_GAUGE into grooves. Usually the
   * endpoint centre-lines; a dead-end overrides it (see getRailLines). */
  railLines(radiusMm?: number, lengthMm?: number): readonly CentreLinePath[];
  /** Silhouette + feature overlays, sans grooves. */
  body(piece: TrackPiece): PieceBody;
}

interface TrackSpec {
  readonly label: string;
  /** Tray override — the experimental track pieces declare 'experiments'. */
  readonly tray?: ToyboxTray;
  readonly tint: string | null;
  readonly markerKind: TrackMarkerKind;
  endpoints(radiusMm?: number, lengthMm?: number): readonly LocalEndpoint[];
  centreLine(index: number, radiusMm?: number, lengthMm?: number): CentreLinePath | undefined;
  /** Override only when the drawn rail differs from the ridden centre-lines. */
  railLines?(radiusMm?: number, lengthMm?: number): readonly CentreLinePath[];
  body(piece: TrackPiece): PieceBody;
}

/** Build a track descriptor. `railLines` defaults to the piece's endpoint
 * centre-lines — every leg's rail is the rail a train rides. */
function trackPiece(spec: TrackSpec): PieceDescriptor {
  const railLines =
    spec.railLines ??
    ((radiusMm?: number, lengthMm?: number): readonly CentreLinePath[] => {
      const out: CentreLinePath[] = [];
      const eps = spec.endpoints(radiusMm, lengthMm);
      for (let i = 0; i < eps.length; i++) {
        const cl = spec.centreLine(i, radiusMm, lengthMm);
        if (cl !== undefined) out.push(cl);
      }
      return out;
    });
  return {
    category: 'track',
    tray: spec.tray ?? 'track',
    label: spec.label,
    tint: spec.tint,
    markerKind: spec.markerKind,
    endpoints: spec.endpoints,
    centreLine: spec.centreLine,
    railLines,
    body: spec.body,
  };
}

/** Build a device descriptor: no topology, no markers, no grooves. */
function devicePiece(
  category: 'device' | 'wire-device',
  label: string,
  body: () => PieceBody,
  tray: ToyboxTray = 'devices',
): PieceDescriptor {
  return {
    category,
    tray,
    label,
    tint: null,
    markerKind: null,
    endpoints: () => [],
    centreLine: () => undefined,
    railLines: () => [],
    body,
  };
}

/** The `curve` and `curve-tight` variants differ only in default radius. */
function curveDescriptor(label: string, defaultRadius: number): PieceDescriptor {
  return trackPiece({
    label,
    tint: null, // a 45° band of beech reads fine; a wash would only mute it
    markerKind: 'block_boundary',
    endpoints: (radiusMm) => curveEndpoints(curveRadiusFor(defaultRadius, radiusMm)),
    centreLine: (index, radiusMm) => {
      const radius = curveRadiusFor(defaultRadius, radiusMm);
      if (index === 0) return curveHalfPath(radius, CURVE_ENTRY_ANGLE);
      if (index === 1) return curveHalfPath(radius, CURVE_EXIT_ANGLE);
      return undefined;
    },
    body: (piece) => curveBody(curveRadiusFor(defaultRadius, piece.radiusMm)),
  });
}

const PIECES: Record<TrackPieceType, PieceDescriptor> = {
  straight: trackPiece({
    label: 'Straight',
    tint: null,
    markerKind: 'block_boundary',
    // Length-aware (LILLABO variants + chain-closing fillers): a `lengthMm`
    // override resizes the endpoints, the ridden centre-line and the drawn plank
    // together. Absent ⇒ the standard 200 mm.
    endpoints: (_radiusMm, lengthMm) => straightEndpoints(lengthMm),
    centreLine: (index, _radiusMm, lengthMm) => {
      const ep = straightEndpoints(lengthMm)[index];
      return ep === undefined ? undefined : linearHalfPath(ep.lx, ep.ly);
    },
    body: (piece) => plankBody(straightLengthFor(piece.lengthMm), []),
  }),
  curve: curveDescriptor('Curve', CURVE_RADIUS_MM),
  'curve-tight': curveDescriptor('Tight Curve', CURVE_TIGHT_RADIUS_MM),
  junction: trackPiece({
    label: 'Junction',
    tint: null, // the Y-fork silhouette reads on its own; a cool wash would grey it
    markerKind: 'junction',
    endpoints: () => JUNCTION_ENDPOINTS,
    centreLine: (index) => junctionCentreLine(index),
    body: junctionBody,
  }),
  station: trackPiece({
    label: 'Station',
    tint: '#f0a02f', // warm honey
    markerKind: 'station_stop',
    ...linearLegs(STATION_ENDPOINTS),
    body: stationBody,
  }),
  terminus: trackPiece({
    label: 'Terminus',
    tint: '#d4513a', // brick-red — the line ends here
    markerKind: 'terminus',
    ...linearLegs(TERMINUS_ENDPOINTS),
    // A dead-end rail genuinely extends PAST its single marker toward the buffer,
    // so its drawn rail (−22→28) is longer than the centre-line a train rides
    // (0→30, ending at the marker). This is the one piece whose drawn rail and
    // ridden path legitimately differ — declared here, derived like every other.
    railLines: () => [segmentPath(-22, 0, 28, 0)],
    body: terminusBody,
  }),
  crossing: trackPiece({
    label: 'Crossing',
    tint: null, // the plus silhouette reads on its own
    markerKind: 'block_boundary',
    ...linearLegs(CROSSING_ENDPOINTS),
    body: crossingBody,
  }),
  ramp: trackPiece({
    label: 'Ramp',
    tint: '#e0902a', // ochre — a change of level
    markerKind: 'block_boundary',
    ...linearLegs(RAMP_ENDPOINTS),
    body: () => plankBody(200, rampChevrons()),
  }),
  train: devicePiece('wire-device', 'Train', trainBody),
  gate: devicePiece('wire-device', 'Gate', gateBody),
  carriage: devicePiece('device', 'Carriage', carriageBody),
  // The railyard is REAL track: a pass-through main line (two endpoints) whose
  // sidings are wooden track with routed grooves. It is also a `gates_zone`
  // device, announced specially at scan time (it is the one piece that is both
  // track and device).
  railyard: trackPiece({
    label: 'Railyard',
    tint: '#caa46a',
    markerKind: 'block_boundary',
    endpoints: () => RAILYARD_ENDPOINTS,
    // The yard's logical position (its zone throat) is its EXIT endpoint (+HALF),
    // not its centre — so a train routed to the yard transits the spine and stops
    // AT the throat, and the interior choreography reverses it straight off the
    // throat into a slot and pulls it straight back out to leave (no centre stop).
    // composeEdgePath builds the train's rendered path from this, so anchoring
    // the half here puts the suspended/departing train at the throat — no teleport.
    centreLine: (index) => {
      const e = RAILYARD_ENDPOINTS[index];
      return e === undefined ? undefined : segmentPath(RAILYARD_HALF_LENGTH_MM, 0, e.lx, e.ly);
    },
    railLines: railyardRailLines,
    body: railyardBody,
  }),
  // The Experiments tray (docs/experimental/ 001–005). Real track / device
  // pieces with real wire identities; the speculative part is the hardware
  // each one pretends to be, never what it puts on the bus.
  'vision-station': trackPiece({
    label: 'Vision Station',
    tray: 'experiments',
    tint: '#f0a02f', // it IS a station — same warm honey
    markerKind: 'station_stop',
    ...linearLegs(STATION_ENDPOINTS),
    body: visionStationBody,
  }),
  turntable: trackPiece({
    label: 'Turntable',
    tray: 'experiments',
    tint: null, // the round disc silhouette reads on its own (ADR-024 §3)
    markerKind: 'junction',
    endpoints: () => TURNTABLE_ENDPOINTS,
    centreLine: (index) => turntableCentreLine(index),
    // Fixed rim stubs only — the bridge grooves ride the rotating deck.
    railLines: turntableRailLines,
    body: turntableBody,
  }),
  'crane-station': trackPiece({
    label: 'Crane',
    tray: 'experiments',
    tint: '#f0a02f', // a station underneath — same warm honey
    markerKind: 'station_stop',
    ...linearLegs(STATION_ENDPOINTS),
    body: craneStationBody,
  }),
  'lift-bridge': trackPiece({
    label: 'Lift Bridge',
    tray: 'experiments',
    tint: '#c97b4a', // warm copper — track that comes and goes
    markerKind: 'block_boundary',
    ...linearLegs(STRAIGHT_ENDPOINTS),
    // The drawn rail is the two fixed approach stubs; the span's grooves ride
    // the hinged deck (`liftBridgeSpan`), which is sometimes not there. The
    // ridden centre-line stays the full chord (the rail a crossing train rides
    // when the span is seated).
    railLines: () => [segmentPath(-100, 0, -72, 0), segmentPath(72, 0, 100, 0)],
    body: liftBridgeBody,
  }),
};

// ---------------------------------------------------------------------------
// Derived tables and predicates — all sourced from the registry above, so a
// new piece is a single PIECES entry with nothing to keep in sync by hand.
// ---------------------------------------------------------------------------

/**
 * Build a `Record<TrackPieceType, V>` by selecting a field from every
 * descriptor. The empty seed is the one cast in this module: it is sound
 * because the loop over the exhaustive `ALL_PIECE_TYPES` assigns every key
 * before the record is read.
 */
function mapPieces<V>(select: (d: PieceDescriptor) => V): Record<TrackPieceType, V> {
  const out = {} as Record<TrackPieceType, V>;
  for (const type of ALL_PIECE_TYPES) out[type] = select(PIECES[type]);
  return out;
}

/**
 * A gentle functional colour wash, layered over the beech wood at low opacity so
 * an operator can read a piece's role at a glance without abandoning the
 * one-material look. Tints are WARM only: a cool wash over warm beech desaturates
 * to drab grey, so the wash is used where a warm hue both reads and helps — a
 * station (honey), a terminus (brick), a ramp (ochre). The most distinctive
 * SILHOUETTES (junction Y-fork, plus crossing) carry no tint. `null` ⇒ plain
 * beech. Derived from each descriptor's `tint`.
 */
export const PIECE_TINT: Record<TrackPieceType, string | null> = mapPieces((d) => d.tint);

/** Display label for each piece type (the toybox caption). Derived from the registry. */
export const PIECE_LABELS: Record<TrackPieceType, string> = mapPieces((d) => d.label);

export function isDevicePiece(type: TrackPieceType): type is DevicePieceType {
  return PIECES[type].category !== 'track';
}

export function isWireDevice(type: TrackPieceType): type is WireDeviceType {
  return PIECES[type].category === 'wire-device';
}

/** Every track-CATEGORY piece (contributes topology), in declaration order —
 * includes the experimental track pieces. Semantic, not a tray: the toybox
 * presents pieces via `TOYBOX_TRAYS`. Derived. */
export const TRACK_PIECE_TYPES: readonly TrackPieceType[] = ALL_PIECE_TYPES.filter(
  (type) => PIECES[type].category === 'track',
);

/** Every device-CATEGORY piece (no topology), in declaration order.
 * Semantic, not a tray. Derived. */
export const DEVICE_PIECE_TYPES: readonly DevicePieceType[] = ALL_PIECE_TYPES.filter(isDevicePiece);

/** Pieces in the toybox "Experiments" tray, in declaration (doc-number) order. */
export const EXPERIMENT_PIECE_TYPES: readonly TrackPieceType[] = ALL_PIECE_TYPES.filter(
  (type) => PIECES[type].tray === 'experiments',
);

/**
 * The toybox tray groups, in display order — Track and Devices staples first,
 * then the Experiments box of viability-test pieces. Derived from each
 * descriptor's `tray`, so a new piece lands in the right box by declaration
 * and the toybox can't fall out of sync.
 */
export const TOYBOX_TRAYS: ReadonlyArray<{
  readonly heading: string;
  readonly types: ReadonlyArray<TrackPieceType>;
}> = [
  { heading: 'Track', types: ALL_PIECE_TYPES.filter((type) => PIECES[type].tray === 'track') },
  { heading: 'Devices', types: ALL_PIECE_TYPES.filter((type) => PIECES[type].tray === 'devices') },
  { heading: 'Experiments', types: EXPERIMENT_PIECE_TYPES },
];

/**
 * A toybox family's pick-list — the variations an operator chooses BEFORE placing
 * a piece, surfaced as a chip strip when that family is armed. The pick is stamped
 * on the placed `TrackPiece` (`lengthMm` for a length axis). Length variations are
 * the loop-closer: a short LILLABO straight fits the residual gap a row of 200 mm
 * planks + curves leaves, so a hand-built loop need not be perfectly symmetric to
 * close. (Colour variations — carriage/train liveries — fold in on the same shape.)
 */
export interface PieceVariation {
  readonly axis: 'length';
  /** Tray heading for the chip strip ("Length"). */
  readonly label: string;
  /** The selectable values (mm), in display order. */
  readonly options: readonly number[];
  /** The value a freshly-armed piece carries — equal to the piece's intrinsic
   *  default, so an untouched pick stamps no override. */
  readonly defaultMm: number;
}

/** Per-type toybox variation families. Absent ⇒ the piece has one fixed form. */
export const PIECE_VARIATIONS: Partial<Record<TrackPieceType, PieceVariation>> = {
  straight: {
    axis: 'length',
    label: 'Length',
    options: LILLABO_STRAIGHT_LENGTHS_MM,
    defaultMm: STRAIGHT_LENGTH_MM,
  },
};

/**
 * The marker kind a piece contributes. Devices declare `null` and resolve to
 * `'block_boundary'` here (defensive/total; no caller should reach it for a
 * device — they gate on `isDevicePiece`).
 */
export function pieceMarkerKind(type: TrackPieceType): TrackMarkerKind {
  return PIECES[type].markerKind ?? 'block_boundary';
}

// ---------------------------------------------------------------------------
// Public geometry API
// ---------------------------------------------------------------------------

/**
 * World-space endpoints for a placed piece, in the same order as the local
 * endpoint definitions (junction: [trunk, through, branch]; crossing: [east,
 * north, west, south]; all others: [entry, exit]).
 */
export function getEndpoints(piece: TrackPiece): ReadonlyArray<TrackEndpoint> {
  const locals = PIECES[piece.type].endpoints(piece.radiusMm, piece.lengthMm);
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

/**
 * World-space centre-line half-path for a placed `piece`, from its centre
 * (marker) out to endpoint `endpointIndex` — the rail a train RIDES. Returns
 * `undefined` for an out-of-range index (device pieces have none). Sampling at
 * `length` reproduces `getEndpoints(piece)[endpointIndex]`'s position and
 * `outgoingAngleDeg`.
 */
export function getCentreLinePath(
  piece: TrackPiece,
  endpointIndex: number,
): CentreLinePath | undefined {
  const local = PIECES[piece.type].centreLine(endpointIndex, piece.radiusMm, piece.lengthMm);
  if (local === undefined) return undefined;
  return worldHalfPath(piece, local);
}

/**
 * World-space rails a placed `piece` DRAWS — the geometry its grooves are routed
 * along. For almost every piece these are exactly the endpoint centre-lines
 * (`getCentreLinePath`), but a dead-end terminus draws a rail that reaches past
 * its only marker to the buffer, so its drawn rail is longer than the ridden
 * path. Keep this distinct from `getCentreLinePath`: unifying them would shorten
 * the terminus rail to the marker and silently break its grooves.
 */
export function getRailLines(piece: TrackPiece): ReadonlyArray<CentreLinePath> {
  return PIECES[piece.type]
    .railLines(piece.radiusMm, piece.lengthMm)
    .map((local) => worldHalfPath(piece, local));
}

/**
 * The drawable geometry of a piece, in piece-local coordinates (origin = piece
 * centre, pointing east). The consumer applies `transform="translate(x,y)
 * rotate(r)"` around the origin.
 *
 * A track piece is a wooden plank (`svgPath`) with twin routed rail `grooves`
 * — derived here, uniformly for every piece, by offsetting the piece's
 * `railLines` ±RAIL_GAUGE — plus any `features`. A device piece puts its coloured
 * body in `svgPath` and its detail in `features`, with no grooves. The renderer
 * owns the palette (wood fill, tint wash, per-role colours); keeping colour out
 * of here leaves this module pure geometry.
 */
export function getPieceShape(piece: TrackPiece): PieceShape {
  const descriptor = PIECES[piece.type];
  const body = descriptor.body(piece);
  const grooves = descriptor
    .railLines(piece.radiusMm)
    .flatMap((rail) => [offsetGroove(rail, 1), offsetGroove(rail, -1)]);
  return {
    svgPath: body.svgPath,
    grooves,
    features: body.features,
    width: body.width,
    height: body.height,
  };
}

/** Saturation caps for the per-layer height cue (see `layerStyle`). Reached
 * around the sixth deck, beyond which extra height stops reading anyway. */
const SHADOW_DY_MAX = 16;
const SHADOW_BLUR_MAX = 12;
const SHADOW_OPACITY_MAX = 0.55;

/**
 * A height cue for a layer group: a drop-shadow offset + blur (and optional
 * opacity) the renderer turns into an SVG `filter`. Pure data; lives next to the
 * piece model so the visual height ramp is defined with the geometry, not buried
 * in JSX.
 *
 * Layer 0 is the ground/baseline (no shadow). Each higher deck floats a little
 * further "above" the table with a larger, softer offset shadow, so a stack of n
 * decks reads as progressively higher rather than collapsing to two looks. The
 * cue grows linearly but SATURATES (`SHADOW_*_MAX`) so a deep stack stays
 * legible instead of casting an absurd shadow — a Brio table is quantised, not
 * theatrical. Layer 1 keeps its original {6,4,0.35} values so existing two-deck
 * layouts are visually unchanged.
 */
export function layerStyle(layer: number): {
  readonly dx: number;
  readonly dy: number;
  readonly blur: number;
  readonly opacity?: number;
} {
  if (layer <= 0) return { dx: 0, dy: 0, blur: 0 };
  return {
    dx: 0,
    dy: Math.min(4 + 2 * layer, SHADOW_DY_MAX),
    blur: Math.min(2 + 2 * layer, SHADOW_BLUR_MAX),
    opacity: Math.min(0.31 + 0.04 * layer, SHADOW_OPACITY_MAX),
  };
}

/** Width (mm) of the slim support column drawn under a raised piece — a pier,
 * not a pillar; the height read comes from the drop-shadow, the column just
 * makes the "standing above the table" explicit. */
export const SUPPORT_COLUMN_WIDTH_MM = 9;

/** A support column under a raised piece, in WORLD coordinates: a slim pier
 * standing under the deck centre and dropping `height` mm down-screen toward the
 * table. The renderer fills it (and a foot) below the deck body. */
export interface SupportColumn {
  /** Centre x of the column (world). */
  readonly x: number;
  /** Deck-underside y where the column meets the piece (world). */
  readonly yTop: number;
  /** Drop in mm from the deck toward the table (the pier's visible length). */
  readonly height: number;
  /** Column width (mm). */
  readonly width: number;
}

/**
 * The support column for a piece, or `null` when it needs none — a device piece
 * (trains/gates ride the track, they don't hold it up) or ground-layer track
 * (it sits on the table). A raised track piece gets a single pier under its
 * centre: the same point the layout marker sits on, which lands on the wooden
 * band for every piece type (a curve's origin is its arc midpoint, see
 * `curvePointR`). It drops down-screen by `dropMm` — pass `layerStyle(layer).dy`
 * so the pier foot lines up with the layer's drop-shadow and the deck reads as
 * floating on its own footing. The caller suppresses the pier when track runs
 * directly beneath (a bridge crossing) via `pierSuppressed` in `overlap.ts`.
 * Pure.
 */
export function supportColumn(piece: TrackPiece, dropMm: number): SupportColumn | null {
  if (isDevicePiece(piece.type)) return null;
  if (layerOf(piece) <= 0) return null;
  return {
    x: piece.position.x,
    yTop: piece.position.y,
    height: dropMm,
    width: SUPPORT_COLUMN_WIDTH_MM,
  };
}
