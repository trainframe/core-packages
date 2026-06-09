import { describe, expect, it } from 'vitest';
import {
  type CentreLinePath,
  EXPERIMENT_PIECE_TYPES,
  PIECE_TINT,
  type RotationDeg,
  SUPPORT_COLUMN_WIDTH_MM,
  TOYBOX_TRAYS,
  TRACK_PIECE_TYPES,
  TURNTABLE_POSITIONS,
  TURNTABLE_POSITION_ANGLE_DEG,
  TURNTABLE_RADIUS_MM,
  type TrackPiece,
  type TrackPieceType,
  getCentreLinePath,
  getEndpoints,
  getPieceShape,
  getRailLines,
  isDevicePiece,
  isWireDevice,
  layerOf,
  layerStyle,
  liftBridgeGap,
  liftBridgeSpan,
  pieceMarkerKind,
  supportColumn,
  turntableDeck,
} from './pieces.js';

function makePiece(type: TrackPiece['type'], rotationDeg: RotationDeg = 0): TrackPiece {
  return { id: 'test', type, position: { x: 0, y: 0 }, rotationDeg, tagged: false };
}

// Tolerance for floating-point comparisons (mm).
const EPS = 0.5;

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected defined endpoint');
  return v;
}

describe('getEndpoints — straight', () => {
  it('returns 2 endpoints at rotation 0', () => {
    const eps = getEndpoints(makePiece('straight'));
    expect(eps).toHaveLength(2);
  });

  it('entry is at (-100, 0) with outgoing angle 180° at rotation 0', () => {
    const [entry] = getEndpoints(makePiece('straight'));
    expect(entry).toBeDefined();
    expect(approx(must(entry).x, -100)).toBe(true);
    expect(approx(must(entry).y, 0)).toBe(true);
    expect(must(entry).outgoingAngleDeg).toBe(180);
  });

  it('exit is at (100, 0) with outgoing angle 0° at rotation 0', () => {
    const [, exit] = getEndpoints(makePiece('straight'));
    expect(exit).toBeDefined();
    expect(approx(must(exit).x, 100)).toBe(true);
    expect(approx(must(exit).y, 0)).toBe(true);
    expect(must(exit).outgoingAngleDeg).toBe(0);
  });

  it('rotates endpoints correctly at 90°', () => {
    const eps = getEndpoints(makePiece('straight', 90));
    // At 90° rotation: (-100, 0) → (0, -100) and (100, 0) → (0, 100)
    expect(approx(must(eps[0]).x, 0)).toBe(true);
    expect(approx(must(eps[0]).y, -100)).toBe(true);
    expect(must(eps[0]).outgoingAngleDeg).toBe(270);
    expect(approx(must(eps[1]).x, 0)).toBe(true);
    expect(approx(must(eps[1]).y, 100)).toBe(true);
    expect(must(eps[1]).outgoingAngleDeg).toBe(90);
  });

  it('rotates endpoints correctly at 45°', () => {
    const eps = getEndpoints(makePiece('straight', 45));
    // At 45°: (-100,0) → ~(-70.7, -70.7)
    const sqrt2over2 = Math.SQRT2 / 2;
    expect(approx(must(eps[0]).x, -100 * sqrt2over2)).toBe(true);
    expect(approx(must(eps[0]).y, -100 * sqrt2over2)).toBe(true);
    expect(must(eps[0]).outgoingAngleDeg).toBe(225);
    expect(must(eps[1]).outgoingAngleDeg).toBe(45);
  });
});

describe('getEndpoints — curve', () => {
  it('returns 2 endpoints', () => {
    expect(getEndpoints(makePiece('curve'))).toHaveLength(2);
  });

  it('entry angle is 180° at rotation 0', () => {
    const [entry] = getEndpoints(makePiece('curve'));
    expect(must(entry).outgoingAngleDeg).toBe(180);
  });

  it('exit angle is 45° at rotation 0', () => {
    const [, exit] = getEndpoints(makePiece('curve'));
    expect(must(exit).outgoingAngleDeg).toBe(45);
  });

  it('angles shift by rotation at 90°', () => {
    const eps = getEndpoints(makePiece('curve', 90));
    expect(must(eps[0]).outgoingAngleDeg).toBe(270);
    expect(must(eps[1]).outgoingAngleDeg).toBe(135);
  });

  it('mirrors the bend when flipped (exit 45° → 315°, y negated)', () => {
    const normal = getEndpoints(makePiece('curve'));
    const flipped = getEndpoints({ ...makePiece('curve'), flipped: true });
    // Entry still faces west; exit bends the other way.
    expect(must(flipped[0]).outgoingAngleDeg).toBe(180);
    expect(must(flipped[1]).outgoingAngleDeg).toBe(315);
    // Each endpoint is reflected across the x-axis (y negated).
    expect(approx(must(flipped[0]).y, -must(normal[0]).y)).toBe(true);
    expect(approx(must(flipped[1]).y, -must(normal[1]).y)).toBe(true);
    expect(approx(must(flipped[1]).x, must(normal[1]).x)).toBe(true);
  });
});

describe('getEndpoints — curve-tight (R=100 variant)', () => {
  it('returns 2 endpoints with the SAME entry/exit tangents as the standard curve', () => {
    const eps = getEndpoints(makePiece('curve-tight'));
    expect(eps).toHaveLength(2);
    // Same 45° sweep / heading lattice as the R=200 curve, so it tiles 8-to-a-circle.
    expect(must(eps[0]).outgoingAngleDeg).toBe(180);
    expect(must(eps[1]).outgoingAngleDeg).toBe(45);
  });

  it('has exactly half the footprint of the standard curve (R=100 vs R=200)', () => {
    const tight = getEndpoints(makePiece('curve-tight'));
    const wide = getEndpoints(makePiece('curve'));
    // Each tight endpoint is the corresponding wide endpoint scaled by 1/2 about
    // the origin (both arcs share the construction centre (−R/2, R), recentred to
    // the arc midpoint), so the compact deck turns back within half the span.
    expect(approx(must(tight[0]).x, must(wide[0]).x / 2)).toBe(true);
    expect(approx(must(tight[0]).y, must(wide[0]).y / 2)).toBe(true);
    expect(approx(must(tight[1]).x, must(wide[1]).x / 2)).toBe(true);
    expect(approx(must(tight[1]).y, must(wide[1]).y / 2)).toBe(true);
  });

  it('mirrors the bend when flipped (exit 45° → 315°, y negated)', () => {
    const normal = getEndpoints(makePiece('curve-tight'));
    const flipped = getEndpoints({ ...makePiece('curve-tight'), flipped: true });
    expect(must(flipped[0]).outgoingAngleDeg).toBe(180);
    expect(must(flipped[1]).outgoingAngleDeg).toBe(315);
    expect(approx(must(flipped[1]).y, -must(normal[1]).y)).toBe(true);
    expect(approx(must(flipped[1]).x, must(normal[1]).x)).toBe(true);
  });

  it('angles shift by rotation at 90° (same lattice as the standard curve)', () => {
    const eps = getEndpoints(makePiece('curve-tight', 90));
    expect(must(eps[0]).outgoingAngleDeg).toBe(270);
    expect(must(eps[1]).outgoingAngleDeg).toBe(135);
  });
});

describe('getEndpoints — junction', () => {
  it('returns 3 endpoints (trunk, through, branch)', () => {
    expect(getEndpoints(makePiece('junction'))).toHaveLength(3);
  });

  it('trunk at index 0 is at (-100, 0) with angle 180° at rotation 0', () => {
    const [trunk] = getEndpoints(makePiece('junction'));
    expect(approx(must(trunk).x, -100)).toBe(true);
    expect(approx(must(trunk).y, 0)).toBe(true);
    expect(must(trunk).outgoingAngleDeg).toBe(180);
  });

  it('through at index 1 is at (100, 0) with angle 0° at rotation 0', () => {
    const [, through] = getEndpoints(makePiece('junction'));
    expect(approx(must(through).x, 100)).toBe(true);
    expect(approx(must(through).y, 0)).toBe(true);
    expect(must(through).outgoingAngleDeg).toBe(0);
  });

  it('branch at index 2 has angle 45° at rotation 0', () => {
    const [, , branch] = getEndpoints(makePiece('junction'));
    expect(must(branch).outgoingAngleDeg).toBe(45);
  });

  it('all angles shift by 90° when rotated 90°', () => {
    const eps = getEndpoints(makePiece('junction', 90));
    expect(must(eps[0]).outgoingAngleDeg).toBe(270);
    expect(must(eps[1]).outgoingAngleDeg).toBe(90);
    expect(must(eps[2]).outgoingAngleDeg).toBe(135);
  });
});

describe('getEndpoints — station', () => {
  it('returns 2 endpoints', () => {
    expect(getEndpoints(makePiece('station'))).toHaveLength(2);
  });

  it('span is 220 mm at rotation 0', () => {
    const [entry, exit] = getEndpoints(makePiece('station'));
    expect(approx(must(entry).x, -110)).toBe(true);
    expect(approx(must(exit).x, 110)).toBe(true);
  });
});

describe('getEndpoints — terminus', () => {
  it('returns 1 endpoint (open end only)', () => {
    expect(getEndpoints(makePiece('terminus'))).toHaveLength(1);
  });

  it('open end is at (30, 0) facing east at rotation 0', () => {
    const [open] = getEndpoints(makePiece('terminus'));
    expect(approx(must(open).x, 30)).toBe(true);
    expect(approx(must(open).y, 0)).toBe(true);
    expect(must(open).outgoingAngleDeg).toBe(0);
  });

  it('rotates correctly at 180°', () => {
    const [open] = getEndpoints(makePiece('terminus', 180));
    expect(approx(must(open).x, -30)).toBe(true);
    expect(approx(must(open).y, 0)).toBe(true);
    expect(must(open).outgoingAngleDeg).toBe(180);
  });
});

describe('getEndpoints — crossing', () => {
  it('returns 4 endpoints', () => {
    expect(getEndpoints(makePiece('crossing'))).toHaveLength(4);
  });

  it('east endpoint is at (100, 0) with angle 0° at rotation 0', () => {
    const [east] = getEndpoints(makePiece('crossing'));
    expect(approx(must(east).x, 100)).toBe(true);
    expect(approx(must(east).y, 0)).toBe(true);
    expect(must(east).outgoingAngleDeg).toBe(0);
  });

  it('north endpoint is at (0, -100) with angle 270° at rotation 0', () => {
    const [, north] = getEndpoints(makePiece('crossing'));
    expect(approx(must(north).x, 0)).toBe(true);
    expect(approx(must(north).y, -100)).toBe(true);
    expect(must(north).outgoingAngleDeg).toBe(270);
  });

  it('rotates all four by 45°', () => {
    const eps = getEndpoints(makePiece('crossing', 45));
    expect(must(eps[0]).outgoingAngleDeg).toBe(45);
    expect(must(eps[1]).outgoingAngleDeg).toBe(315);
    expect(must(eps[2]).outgoingAngleDeg).toBe(225);
    expect(must(eps[3]).outgoingAngleDeg).toBe(135);
  });
});

describe('getEndpoints — carriage', () => {
  it('returns 0 endpoints (no track topology)', () => {
    expect(getEndpoints(makePiece('carriage'))).toHaveLength(0);
  });
});

describe('getPieceShape — carriage', () => {
  it('returns a non-empty svgPath', () => {
    const shape = getPieceShape(makePiece('carriage'));
    expect(shape.svgPath.length).toBeGreaterThan(0);
  });

  it('is smaller than the train (60mm vs 80mm wide)', () => {
    const carriageShape = getPieceShape(makePiece('carriage'));
    const trainShape = getPieceShape(makePiece('train'));
    expect(carriageShape.width).toBe(60);
    expect(carriageShape.width).toBeLessThan(trainShape.width);
  });

  it('has the same height as the train (24mm — fits on the rail band)', () => {
    const carriageShape = getPieceShape(makePiece('carriage'));
    const trainShape = getPieceShape(makePiece('train'));
    expect(carriageShape.height).toBe(trainShape.height);
  });
});

describe('isDevicePiece and isWireDevice — carriage', () => {
  it('isDevicePiece returns true for carriage', () => {
    expect(isDevicePiece('carriage')).toBe(true);
  });

  it('isWireDevice returns false for carriage', () => {
    expect(isWireDevice('carriage')).toBe(false);
  });

  it('isWireDevice returns true for train', () => {
    expect(isWireDevice('train')).toBe(true);
  });

  it('isWireDevice returns true for gate', () => {
    expect(isWireDevice('gate')).toBe(true);
  });

  it('pieceMarkerKind returns block_boundary for carriage (defensive/total)', () => {
    expect(pieceMarkerKind('carriage')).toBe('block_boundary');
  });
});

describe('getPieceShape', () => {
  const PIECE_TYPES: TrackPiece['type'][] = [
    'straight',
    'curve',
    'curve-tight',
    'junction',
    'station',
    'terminus',
    'crossing',
  ];

  for (const type of PIECE_TYPES) {
    it(`returns a non-empty svgPath for ${type}`, () => {
      const shape = getPieceShape(makePiece(type));
      expect(shape.svgPath.length).toBeGreaterThan(0);
      expect(shape.width).toBeGreaterThan(0);
      expect(shape.height).toBeGreaterThan(0);
    });
  }

  it('straight shape has width 200', () => {
    expect(getPieceShape(makePiece('straight')).width).toBe(200);
  });

  it('station shape has width 220', () => {
    expect(getPieceShape(makePiece('station')).width).toBe(220);
  });

  it('terminus shape has width 60', () => {
    expect(getPieceShape(makePiece('terminus')).width).toBe(60);
  });

  it('the junction branch wood sweeps along its centre-line at a half-plank width', () => {
    // The branch plank must follow the SAME (bezier) centre-line a diverting
    // train rides — PLANK_HALF_WIDTH to each side of it — so the wood curves with
    // its rails instead of running straight off them while the grooves bend away.
    // Check the swept band has an edge vertex at ±half-width perpendicular to the
    // rail at its midpoint (mirrors the groove test, one plank-width out).
    const PLANK_HALF_WIDTH = 13;
    const branch = must(getCentreLinePath(makePiece('junction'), 2));
    const mid = branch.at(branch.length / 2);
    const normal = ((mid.headingDeg + 90) * Math.PI) / 180;
    const edges = [1, -1].map((s) => ({
      x: mid.x + s * PLANK_HALF_WIDTH * Math.cos(normal),
      y: mid.y + s * PLANK_HALF_WIDTH * Math.sin(normal),
    }));
    // The swept band is built from M/L vertices; pull them out of the body path.
    const verts = [
      ...getPieceShape(makePiece('junction')).svgPath.matchAll(
        /[ML]\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
      ),
    ].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    for (const e of edges) {
      const nearest = Math.min(...verts.map((v) => Math.hypot(v.x - e.x, v.y - e.y)));
      expect(nearest).toBeLessThan(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Wooden-material decor: rail grooves, feature overlays, functional tints.
// ---------------------------------------------------------------------------

describe('getPieceShape — rail grooves', () => {
  const TRACK_TYPES: TrackPieceType[] = [
    'straight',
    'curve',
    'curve-tight',
    'junction',
    'station',
    'terminus',
    'crossing',
    'ramp',
  ];

  for (const type of TRACK_TYPES) {
    it(`${type} has at least two routed grooves`, () => {
      // Every track piece carries twin rail channels (one pair per leg).
      expect(getPieceShape(makePiece(type)).grooves.length).toBeGreaterThanOrEqual(2);
    });
  }

  for (const type of ['train', 'gate', 'carriage'] as TrackPieceType[]) {
    it(`${type} (a device) has no grooves`, () => {
      expect(getPieceShape(makePiece(type)).grooves).toHaveLength(0);
    });
  }

  it('a straight piece routes its grooves at ±RAIL_GAUGE about the rail', () => {
    // The grooves are offset from the centre-line a train rides; for a straight
    // that centre-line is the x-axis, so every groove vertex sits at |y| ≈ gauge.
    const RAIL_GAUGE = 5;
    const grooves = getPieceShape(makePiece('straight')).grooves;
    const ys = grooves.flatMap((g) =>
      [...g.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2])),
    );
    expect(ys.length).toBeGreaterThan(0);
    for (const y of ys) expect(Math.abs(y)).toBeCloseTo(RAIL_GAUGE, 1);
  });

  it('the junction branch groove follows the bezier centre-line a train rides', () => {
    // The branch leg's groove must track its (curved) centre-line, not a straight
    // 45° chord — otherwise a diverting train bows off its own rail. Sample the
    // branch centre-line, offset it by the gauge, and check a matching groove
    // vertex exists for an interior point.
    const RAIL_GAUGE = 5;
    const branch = must(getCentreLinePath(makePiece('junction'), 2));
    const mid = branch.at(branch.length / 2);
    const normal = ((mid.headingDeg + 90) * Math.PI) / 180;
    const target = {
      x: mid.x + RAIL_GAUGE * Math.cos(normal),
      y: mid.y + RAIL_GAUGE * Math.sin(normal),
    };
    const verts = getPieceShape(makePiece('junction')).grooves.flatMap((g) =>
      [...g.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
      })),
    );
    // Nearest groove vertex to the curved rail's offset midpoint. A correct
    // (bezier-following) groove lands within a groove-sample step (~4mm); a wrong
    // straight-45°-chord groove would bow away by ~10mm, so 5mm separates them.
    const nearest = Math.min(...verts.map((v) => Math.hypot(v.x - target.x, v.y - target.y)));
    expect(nearest).toBeLessThan(5);
  });
});

describe('rail grooves derive uniformly from each piece’s rail lines', () => {
  // The registry makes grooves a single derived thing — every track piece's
  // grooves are exactly the ±RAIL_GAUGE offsets of its declared `railLines`, so
  // no piece can hand-author a groove path that drifts from its rails (the old
  // terminus did exactly that). This guards the mechanism for every type at once.
  const RAIL_GAUGE = 5;

  function parseVerts(d: string): Array<{ x: number; y: number }> {
    return [...d.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
  }

  /** Min distance from a point to a finely-sampled rail polyline. */
  function distToRail(v: { x: number; y: number }, rail: CentreLinePath): number {
    let min = Number.POSITIVE_INFINITY;
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const p = rail.at((i / N) * rail.length);
      const d = Math.hypot(p.x - v.x, p.y - v.y);
      if (d < min) min = d;
    }
    return min;
  }

  for (const type of TRACK_PIECE_TYPES) {
    it(`${type}: two grooves per rail line, each riding exactly RAIL_GAUGE off it`, () => {
      const piece = makePiece(type);
      const rails = getRailLines(piece);
      const grooves = getPieceShape(piece).grooves;
      expect(rails.length).toBeGreaterThan(0);
      // Two channels (±gauge) per rail line — no extra, hand-authored grooves.
      expect(grooves.length).toBe(rails.length * 2);
      // Every groove vertex sits one gauge off its parent rail (grooves[2i],
      // grooves[2i+1] are the ± pair for rails[i]).
      for (let r = 0; r < rails.length; r++) {
        const rail = must(rails[r]);
        for (const offset of [0, 1]) {
          for (const v of parseVerts(must(grooves[r * 2 + offset]))) {
            expect(Math.abs(distToRail(v, rail) - RAIL_GAUGE)).toBeLessThan(0.8);
          }
        }
      }
    });
  }

  it('the terminus rail spans the full plank (buffer stub → open end), past its only marker', () => {
    // The case that used to be hand-drawn: a dead-end's drawn rail reaches BACK
    // toward the buffer, past the single marker. Its ridden centre-line stops at
    // the marker (0→30). Locking this keeps terminus on the same derived path.
    const [rail] = getRailLines(makePiece('terminus'));
    const start = must(rail).at(0);
    const end = must(rail).at(must(rail).length);
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    expect(minX).toBeLessThan(-18); // reaches back toward the buffer
    expect(maxX).toBeGreaterThan(26); // and out to the open end
    // The ridden centre-line, by contrast, ends at the marker-side endpoint.
    expect(must(getCentreLinePath(makePiece('terminus'), 0)).length).toBeCloseTo(30, 3);
  });
});

describe('getPieceShape — feature overlays', () => {
  const has = (type: TrackPieceType, role: string): boolean =>
    getPieceShape(makePiece(type)).features.some((f) => f.role === role);

  it('a station has a raised platform', () => expect(has('station', 'platform')).toBe(true));
  it('a terminus has a dark-wood buffer', () => expect(has('terminus', 'dark-wood')).toBe(true));
  it('a ramp has chevron lines', () => expect(has('ramp', 'line')).toBe(true));
  it('a loco has glass and a lamp', () => {
    expect(has('train', 'glass')).toBe(true);
    expect(has('train', 'pop')).toBe(true);
  });
  it('a gate has a danger boom', () => expect(has('gate', 'danger')).toBe(true));
  it('a plain straight has no features', () =>
    expect(getPieceShape(makePiece('straight')).features).toHaveLength(0));
});

describe('PIECE_TINT — functional colour wash', () => {
  it('the warm-tinted role pieces carry a tint', () => {
    // Only warm hues read over beech, so the wash is used where it both reads
    // and helps: station, terminus, ramp.
    for (const type of ['station', 'terminus', 'ramp'] as TrackPieceType[]) {
      expect(PIECE_TINT[type]).not.toBeNull();
    }
  });
  it('plain track, distinctively-shaped pieces, and devices carry no tint', () => {
    // junction (Y-fork) and crossing (plus) read from their silhouette; a cool
    // wash would only grey the wood.
    for (const type of [
      'straight',
      'curve',
      'curve-tight',
      'junction',
      'crossing',
      'train',
      'gate',
      'carriage',
    ] as TrackPieceType[]) {
      expect(PIECE_TINT[type]).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// getCentreLinePath — rail geometry from the piece centre (marker) to an end.
// ---------------------------------------------------------------------------

const CURVE_HALF_LEN = 200 * (Math.PI / 8); // R · 22.5° in rad ≈ 78.54mm

/** Normalised absolute angular difference in degrees, in [0, 180]. */
function angleDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

describe('getCentreLinePath — half lengths', () => {
  it('straight half-length is 100mm (200mm piece, centre to end)', () => {
    const path = must(getCentreLinePath(makePiece('straight'), 0));
    expect(path.length).toBeCloseTo(100, 3);
  });

  it('station half-length is 110mm', () => {
    const path = must(getCentreLinePath(makePiece('station'), 0));
    expect(path.length).toBeCloseTo(110, 3);
  });

  it('junction trunk/through halves are 100mm straight chords', () => {
    const j = makePiece('junction');
    expect(must(getCentreLinePath(j, 0)).length).toBeCloseTo(100, 3);
    expect(must(getCentreLinePath(j, 1)).length).toBeCloseTo(100, 3);
  });

  it('junction branch half is a smooth turn (arc length > the 100mm chord)', () => {
    // The branch leg is no longer a straight chord but a Bézier turn from the
    // trunk axis to the 45° branch endpoint, so its arc length exceeds the
    // straight-line 100mm — but only modestly (it's a gentle 45° turn).
    const branch = must(getCentreLinePath(makePiece('junction'), 2));
    expect(branch.length).toBeGreaterThan(100);
    expect(branch.length).toBeLessThan(115);
    // Heading at the centre is the trunk axis (0°), so a diverting train doesn't
    // snap its heading at the marker; at the far end it's the 45° branch tangent.
    expect(angleDelta(branch.at(0).headingDeg, 0)).toBeLessThan(0.5);
    expect(angleDelta(branch.at(branch.length).headingDeg, 45)).toBeLessThan(0.5);
  });

  it('terminus half-length is 30mm', () => {
    expect(must(getCentreLinePath(makePiece('terminus'), 0)).length).toBeCloseTo(30, 3);
  });

  it('curve half-length is the ARC length R·(π/8) ≈ 78.54mm (not the chord)', () => {
    const path = must(getCentreLinePath(makePiece('curve'), 0));
    expect(path.length).toBeCloseTo(CURVE_HALF_LEN, 2);
    expect(path.length).toBeGreaterThan(CURVE_HALF_LEN - 0.01);
  });

  it('curve-tight half-length is HALF the standard curve arc (R=100 · π/8 ≈ 39.27mm)', () => {
    const path = must(getCentreLinePath(makePiece('curve-tight'), 0));
    expect(path.length).toBeCloseTo(CURVE_HALF_LEN / 2, 2);
  });

  it('curve-tight: sampling at length reproduces its endpoint pose', () => {
    const piece = makePiece('curve-tight', 90);
    const eps = getEndpoints(piece);
    for (const i of [0, 1]) {
      const path = must(getCentreLinePath(piece, i));
      const end = path.at(path.length);
      expect(approx(end.x, must(eps[i]).x)).toBe(true);
      expect(approx(end.y, must(eps[i]).y)).toBe(true);
      expect(angleDelta(end.headingDeg, must(eps[i]).outgoingAngleDeg)).toBeLessThan(0.5);
    }
  });

  it('returns undefined for a device piece (no endpoints)', () => {
    expect(getCentreLinePath(makePiece('train'), 0)).toBeUndefined();
    expect(getCentreLinePath(makePiece('curve'), 5)).toBeUndefined();
  });
});

describe('getCentreLinePath — sampling reproduces getEndpoints at the far end', () => {
  it('straight: sampling at length matches endpoint position and outgoing angle', () => {
    const piece = makePiece('straight', 90);
    const eps = getEndpoints(piece);
    for (const i of [0, 1]) {
      const path = must(getCentreLinePath(piece, i));
      const end = path.at(path.length);
      expect(approx(end.x, must(eps[i]).x)).toBe(true);
      expect(approx(end.y, must(eps[i]).y)).toBe(true);
      expect(angleDelta(end.headingDeg, must(eps[i]).outgoingAngleDeg)).toBeLessThan(0.5);
    }
  });

  it('curve: sampling at length matches endpoint position and arc-tangent angle', () => {
    const piece = makePiece('curve');
    const eps = getEndpoints(piece);
    for (const i of [0, 1]) {
      const path = must(getCentreLinePath(piece, i));
      const end = path.at(path.length);
      expect(approx(end.x, must(eps[i]).x)).toBe(true);
      expect(approx(end.y, must(eps[i]).y)).toBe(true);
      expect(angleDelta(end.headingDeg, must(eps[i]).outgoingAngleDeg)).toBeLessThan(0.5);
    }
    // At the centre (d=0) the curve sits at the origin (the marker).
    const start = must(getCentreLinePath(piece, 0)).at(0);
    expect(approx(start.x, 0)).toBe(true);
    expect(approx(start.y, 0)).toBe(true);
  });

  it('junction: each leg reproduces its endpoint position and angle', () => {
    const piece = makePiece('junction', 45);
    const eps = getEndpoints(piece);
    for (const i of [0, 1, 2]) {
      const path = must(getCentreLinePath(piece, i));
      const end = path.at(path.length);
      expect(approx(end.x, must(eps[i]).x)).toBe(true);
      expect(approx(end.y, must(eps[i]).y)).toBe(true);
      expect(angleDelta(end.headingDeg, must(eps[i]).outgoingAngleDeg)).toBeLessThan(0.5);
    }
  });
});

describe('getCentreLinePath — flip and rotation', () => {
  it('a FLIPPED curve mirrors position AND heading across the x-axis', () => {
    const normalPath = must(getCentreLinePath(makePiece('curve'), 1));
    const flippedPath = must(getCentreLinePath({ ...makePiece('curve'), flipped: true }, 1));
    const dMid = normalPath.length / 2;
    const n = normalPath.at(dMid);
    const f = flippedPath.at(dMid);
    // x preserved, y mirrored.
    expect(approx(f.x, n.x)).toBe(true);
    expect(approx(f.y, -n.y)).toBe(true);
    // Heading reflected across the x-axis (negated).
    expect(angleDelta(f.headingDeg, -n.headingDeg)).toBeLessThan(0.5);
  });

  it('a ROTATED (90°) curve rotates position AND heading by 90°', () => {
    const base = must(getCentreLinePath(makePiece('curve'), 1));
    const rot = must(getCentreLinePath(makePiece('curve', 90), 1));
    const dMid = base.length / 2;
    const b = base.at(dMid);
    const r = rot.at(dMid);
    // Rotating (x,y) by +90° clockwise (SVG): (x,y) → (-y, x) about origin.
    expect(approx(r.x, -b.y)).toBe(true);
    expect(approx(r.y, b.x)).toBe(true);
    expect(angleDelta(r.headingDeg, b.headingDeg + 90)).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Layers — the editor-only height field, the ramp's cross-layer endpoint, and
// the layerStyle height cue.
// ---------------------------------------------------------------------------

describe('layerOf — the single ground-default', () => {
  it('absent layer defaults to ground (0)', () => {
    expect(layerOf(makePiece('straight'))).toBe(0);
  });

  it('reads an explicit layer', () => {
    const p: TrackPiece = { ...makePiece('straight'), layer: 2 };
    expect(layerOf(p)).toBe(2);
  });
});

describe('getEndpoints — layer', () => {
  it('a ground straight has both endpoints on layer 0', () => {
    const eps = getEndpoints(makePiece('straight'));
    expect(eps.map((e) => e.layer)).toEqual([0, 0]);
  });

  it('an upper-layer straight carries that layer on both endpoints', () => {
    const p: TrackPiece = { ...makePiece('straight'), layer: 1 };
    const eps = getEndpoints(p);
    expect(eps.map((e) => e.layer)).toEqual([1, 1]);
  });

  it('a ramp entry stays on piece.layer; exit is one layer higher', () => {
    const eps = getEndpoints(makePiece('ramp'));
    expect(eps).toHaveLength(2);
    expect(eps[0]?.layer).toBe(0); // entry
    expect(eps[1]?.layer).toBe(1); // exit (layerDelta 1)
  });

  it('a ramp authored on layer 1 spans layers 1 → 2', () => {
    const p: TrackPiece = { ...makePiece('ramp'), layer: 1 };
    const eps = getEndpoints(p);
    expect(eps[0]?.layer).toBe(1);
    expect(eps[1]?.layer).toBe(2);
  });

  it('the ramp reuses the straight 200 mm footprint (entry/exit at ±100)', () => {
    const eps = getEndpoints(makePiece('ramp'));
    expect(approx(must(eps[0]).x, -100)).toBe(true);
    expect(approx(must(eps[1]).x, 100)).toBe(true);
  });
});

describe('pieceMarkerKind — ramp', () => {
  it('a ramp is an ordinary block_boundary (no new marker kind)', () => {
    expect(pieceMarkerKind('ramp')).toBe('block_boundary');
  });
});

describe('getPieceShape — ramp', () => {
  it('returns a 200×26 plank matching the straight footprint', () => {
    const shape = getPieceShape(makePiece('ramp'));
    expect(shape.width).toBe(200);
    // Same footprint as a straight plank (the two snap and tile interchangeably).
    expect(shape.height).toBe(getPieceShape(makePiece('straight')).height);
    expect(shape.height).toBe(26);
    expect(shape.svgPath.length).toBeGreaterThan(0);
  });
});

describe('layerStyle — height cue', () => {
  it('ground (0) has no shadow', () => {
    expect(layerStyle(0)).toEqual({ dx: 0, dy: 0, blur: 0 });
  });

  it('negative/zero layers clamp to no shadow', () => {
    expect(layerStyle(-1)).toEqual({ dx: 0, dy: 0, blur: 0 });
  });

  it('layer 1 floats with a soft offset shadow', () => {
    const s = layerStyle(1);
    expect(s.dy).toBeGreaterThan(0);
    expect(s.blur).toBeGreaterThan(0);
  });

  it('each deck casts a progressively larger shadow than the one below', () => {
    expect(layerStyle(2).dy).toBeGreaterThan(layerStyle(1).dy);
    expect(layerStyle(3).dy).toBeGreaterThan(layerStyle(2).dy);
    expect(layerStyle(4).dy).toBeGreaterThan(layerStyle(3).dy);
  });

  it('the height cue saturates so a deep stack stays legible', () => {
    // A tall stack must not cast an ever-growing shadow; deep decks clamp.
    expect(layerStyle(20).dy).toBe(layerStyle(10).dy);
    expect(layerStyle(20).dy).toBeLessThanOrEqual(16);
  });

  it('layer 1 keeps its original values so two-deck layouts are unchanged', () => {
    expect(layerStyle(1)).toEqual({ dx: 0, dy: 6, blur: 4, opacity: 0.35 });
  });
});

describe('supportColumn — pier under a raised piece', () => {
  const raised = (layer: number): TrackPiece => ({
    id: 'p',
    type: 'straight',
    position: { x: 120, y: 80 },
    rotationDeg: 0,
    tagged: false,
    ...(layer !== 0 ? { layer } : {}),
  });

  it('ground track gets no pier', () => {
    expect(supportColumn(raised(0), 6)).toBeNull();
  });

  it('a device piece gets no pier even when raised', () => {
    const train: TrackPiece = {
      id: 't',
      type: 'train',
      position: { x: 0, y: 0 },
      rotationDeg: 0,
      tagged: false,
      layer: 2,
    };
    expect(supportColumn(train, 10)).toBeNull();
  });

  it('a raised piece stands a column under its centre, dropping by the given offset', () => {
    const col = supportColumn(raised(1), 6);
    expect(col).not.toBeNull();
    expect(col?.x).toBe(120);
    expect(col?.yTop).toBe(80);
    expect(col?.height).toBe(6);
    expect(col?.width).toBe(SUPPORT_COLUMN_WIDTH_MM);
  });

  it('a deeper deck drops a taller column when passed its larger shadow offset', () => {
    const l1 = supportColumn(raised(1), layerStyle(1).dy);
    const l3 = supportColumn(raised(3), layerStyle(3).dy);
    expect((l3?.height ?? 0) > (l1?.height ?? 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Experimental pieces (docs/experimental 001–005) — the "Experiments" tray
// ---------------------------------------------------------------------------

describe('getEndpoints — turntable (experimental 002)', () => {
  it('returns 4 endpoints: trunk west + three exit stubs on the 45° lattice', () => {
    const eps = getEndpoints(makePiece('turntable'));
    expect(eps).toHaveLength(4);
    const [trunk, a, b, c] = eps;
    expect(approx(must(trunk).x, -100) && approx(must(trunk).y, 0)).toBe(true);
    expect(must(trunk).outgoingAngleDeg).toBe(180);
    expect(approx(must(a).x, 100) && approx(must(a).y, 0)).toBe(true);
    expect(must(a).outgoingAngleDeg).toBe(0);
    expect(approx(must(b).x, 70.71) && approx(must(b).y, 70.71)).toBe(true);
    expect(must(b).outgoingAngleDeg).toBe(45);
    expect(approx(must(c).x, 70.71) && approx(must(c).y, -70.71)).toBe(true);
    expect(must(c).outgoingAngleDeg).toBe(315);
  });

  it('every endpoint sits exactly on the disc rim (TURNTABLE_RADIUS_MM)', () => {
    for (const ep of getEndpoints(makePiece('turntable'))) {
      expect(approx(Math.hypot(ep.x, ep.y), TURNTABLE_RADIUS_MM)).toBe(true);
    }
  });

  it('the ±45° stub centre-lines turn smoothly: 0° at the marker, stub angle at the rim', () => {
    const p = makePiece('turntable');
    for (const [index, endAngle] of [
      [2, 45],
      [3, 315],
    ] as const) {
      const path = must(getCentreLinePath(p, index));
      expect(approx(path.at(0).headingDeg, 0) || approx(path.at(0).headingDeg, 360)).toBe(true);
      expect(approx(path.at(path.length).headingDeg, endAngle)).toBe(true);
    }
  });

  it('is a junction marker with no tint (the disc silhouette reads on its own)', () => {
    expect(pieceMarkerKind('turntable')).toBe('junction');
    expect(PIECE_TINT.turntable).toBeNull();
  });

  it('routes grooves only at the fixed rim stubs; the bridge grooves ride the deck', () => {
    // 4 stubs × 2 grooves. The rotating deck (turntableDeck) carries its own.
    const shape = getPieceShape(makePiece('turntable'));
    expect(shape.grooves).toHaveLength(8);
    const deck = turntableDeck();
    expect(deck.grooves).toHaveLength(2);
    expect(deck.svgPath.length).toBeGreaterThan(0);
  });

  it('declares one deck angle per confirmed position', () => {
    expect(TURNTABLE_POSITIONS).toEqual(['stub-a', 'stub-b', 'stub-c']);
    expect(TURNTABLE_POSITION_ANGLE_DEG['stub-a']).toBe(0);
    expect(TURNTABLE_POSITION_ANGLE_DEG['stub-b']).toBe(45);
    expect(TURNTABLE_POSITION_ANGLE_DEG['stub-c']).toBe(-45);
  });
});

describe('vision station + crane (experimental 001 / 003) — stations underneath', () => {
  for (const type of ['vision-station', 'crane-station'] as const) {
    it(`${type} has the station footprint, marker kind and honey tint`, () => {
      const eps = getEndpoints(makePiece(type));
      expect(eps).toHaveLength(2);
      expect(approx(must(eps[0]).x, -110) && approx(must(eps[1]).x, 110)).toBe(true);
      expect(pieceMarkerKind(type)).toBe('station_stop');
      expect(PIECE_TINT[type]).toBe(PIECE_TINT.station);
    });
  }

  it('the vision station carries a metal sensor mast with a glass lens (and no extra motion)', () => {
    const shape = getPieceShape(makePiece('vision-station'));
    expect(shape.features.some((f) => f.role === 'metal')).toBe(true);
    expect(shape.features.some((f) => f.role === 'glass')).toBe(true);
  });

  it('the crane carries a metal gantry and warm-accent (pop) crates', () => {
    const shape = getPieceShape(makePiece('crane-station'));
    expect(shape.features.filter((f) => f.role === 'metal').length).toBeGreaterThanOrEqual(3);
    expect(shape.features.filter((f) => f.role === 'pop').length).toBeGreaterThanOrEqual(3);
  });
});

describe('lift bridge (experimental 005) — a hinged wooden span', () => {
  it('has the straight footprint and a block_boundary marker', () => {
    const eps = getEndpoints(makePiece('lift-bridge'));
    expect(eps).toHaveLength(2);
    expect(approx(must(eps[0]).x, -100) && approx(must(eps[1]).x, 100)).toBe(true);
    expect(pieceMarkerKind('lift-bridge')).toBe('block_boundary');
  });

  it('draws grooves only over the fixed approaches; the span carries its own', () => {
    // 2 approach rails × 2 grooves; the hinged deck's grooves tilt with it.
    const shape = getPieceShape(makePiece('lift-bridge'));
    expect(shape.grooves).toHaveLength(4);
    const span = liftBridgeSpan();
    expect(span.grooves).toHaveLength(2);
    // The pivot fitting is the span's metal feature.
    expect(span.features.some((f) => f.role === 'metal')).toBe(true);
    expect(liftBridgeGap().length).toBeGreaterThan(0);
  });

  it('the ridden centre-line still spans marker → endpoint (the rail when seated)', () => {
    const path = must(getCentreLinePath(makePiece('lift-bridge'), 1));
    expect(approx(path.length, 100)).toBe(true);
  });
});

describe('decoupler (experimental 004) — a wire device, not track', () => {
  it('has no endpoints, no grooves, and a wire identity', () => {
    expect(getEndpoints(makePiece('decoupler'))).toHaveLength(0);
    expect(getPieceShape(makePiece('decoupler')).grooves).toHaveLength(0);
    expect(isDevicePiece('decoupler')).toBe(true);
    expect(isWireDevice('decoupler')).toBe(true);
  });

  it('shows the wedge as a pop accent in its slot', () => {
    const shape = getPieceShape(makePiece('decoupler'));
    expect(shape.features.some((f) => f.role === 'pop')).toBe(true);
    expect(shape.features.some((f) => f.role === 'line')).toBe(true);
  });
});

describe('the Experiments toybox tray', () => {
  it('groups the five experimental pieces, in design-doc order, apart from the staples', () => {
    const trays = new Map(TOYBOX_TRAYS.map((t) => [t.heading, t.types]));
    expect([...trays.keys()]).toEqual(['Track', 'Devices', 'Experiments']);
    expect(trays.get('Experiments')).toEqual([
      'vision-station',
      'turntable',
      'crane-station',
      'decoupler',
      'lift-bridge',
    ]);
    expect(trays.get('Experiments')).toEqual(EXPERIMENT_PIECE_TYPES);
    // The staple trays don't re-list the experiments.
    for (const heading of ['Track', 'Devices'] as const) {
      for (const type of trays.get(heading) ?? []) {
        expect(EXPERIMENT_PIECE_TYPES).not.toContain(type);
      }
    }
    expect(trays.get('Devices')).not.toContain('decoupler');
  });

  it('experimental TRACK pieces still register as track topology (semantic lists unchanged)', () => {
    for (const type of ['vision-station', 'turntable', 'crane-station', 'lift-bridge'] as const) {
      expect(TRACK_PIECE_TYPES).toContain(type);
      expect(isDevicePiece(type)).toBe(false);
    }
  });
});
