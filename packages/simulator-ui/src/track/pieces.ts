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
  | 'crossing';

/** Rotation is constrained to multiples of 45° in the range [0, 315]. */
export type RotationDeg = 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315;

export interface TrackPiece {
  readonly id: string;
  readonly type: TrackPieceType;
  readonly position: { readonly x: number; readonly y: number };
  readonly rotationDeg: RotationDeg;
  /** When true, the piece carries an RFID tag (renders a badge icon). */
  readonly tagged: boolean;
}

export interface TrackEndpoint {
  readonly x: number;
  readonly y: number;
  /** Angle (degrees, clockwise from east) at which a train exits this endpoint. */
  readonly outgoingAngleDeg: number;
}

export interface PieceShape {
  readonly svgPath: string;
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
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
): ReadonlyArray<{ lx: number; ly: number; localAngle: number }> {
  switch (type) {
    case 'straight':
      // Two endpoints 200 mm apart, centred on origin.
      return [
        { lx: -100, ly: 0, localAngle: 180 },
        { lx: 100, ly: 0, localAngle: 0 },
      ];
    case 'curve':
      // 45° arc. Entry at west (180°), exit at north-east (45°).
      // Chord approximation: entry at (-100, 0), exit rotated 45° from east.
      return [
        { lx: -100, ly: 0, localAngle: 180 },
        { lx: 100 * Math.cos(toRad(45)), ly: -100 * Math.sin(toRad(45)), localAngle: 45 },
      ];
    case 'junction':
      // 3 endpoints: trunk (west, index 0), through (east, index 1), branch (northeast, index 2).
      return [
        { lx: -100, ly: 0, localAngle: 180 }, // trunk
        { lx: 100, ly: 0, localAngle: 0 }, // through (main)
        { lx: 100 * Math.cos(toRad(45)), ly: -100 * Math.sin(toRad(45)), localAngle: 45 }, // branch (divert)
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
  return locals.map(({ lx, ly, localAngle }) => {
    const world = transformPoint(lx, ly, piece.rotationDeg, piece.position.x, piece.position.y);
    return {
      x: world.x,
      y: world.y,
      outgoingAngleDeg: normaliseAngle(localAngle + piece.rotationDeg),
    };
  });
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
  // Arc from west to 45° northeast, radius ~141 mm (chord 100 mm at 45°).
  // Use SVG arc command. The rail band is 16 mm wide.
  // Origin at centre of bounding box.
  const R = 150; // outer radius of arc band
  const r = R - 16; // inner radius
  // Arc starts at (-R, 0) relative to arc centre, ends at 45° above east.
  // Arc centre is at (0, R) to produce a curve going right+up.
  // We'll draw in a coordinate system where entry is at (-100, 0).
  // Arc centre is placed at (-100 + R*cos(90), 0 + R*sin(90)) = (-100 + 0, R) = (-100, R).
  const cx = -100;
  const cy = R;
  const ex = cx + R * Math.cos(toRad(-45)); // end at 45° from centre
  const ey = cy + R * Math.sin(toRad(-45));
  const irx = cx + r * Math.cos(toRad(-45));
  const iry = cy + r * Math.sin(toRad(-45));

  const d = `M ${-100} ${-8} A ${R} ${R} 0 0 1 ${ex.toFixed(1)} ${(ey - 8).toFixed(1)} L ${irx.toFixed(1)} ${(iry + 8).toFixed(1)} A ${r} ${r} 0 0 0 ${-100} ${8} Z`;

  return { svgPath: d, width: 210, height: 160 };
}

function junctionShape(): PieceShape {
  // Y-shape: trunk on left, straight through on right, branch northeast.
  // Main rail band 16 mm wide.
  // Trunk-through rail (full straight) + branch rail to northeast 45°
  const bx = (100 * Math.cos(toRad(45))).toFixed(1);
  const by1 = (-100 * Math.sin(toRad(45)) - 8).toFixed(1);
  const by2 = (-100 * Math.sin(toRad(45)) + 8).toFixed(1);
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
