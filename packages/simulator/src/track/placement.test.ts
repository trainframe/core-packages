import { describe, expect, it } from 'vitest';
import { nearestStartEdge } from '../sim/nearest-edge.js';
import { compileLayout } from './layout-from-pieces.js';
import { type RotationDeg, type TrackPiece, getEndpoints } from './pieces.js';
import { CONNECT_CAPTURE_MM, computeMovePlacement, computePlacement } from './placement.js';

function piece(
  id: string,
  type: TrackPiece['type'],
  x: number,
  y: number,
  rot: number,
): TrackPiece {
  return { id, type, position: { x, y }, rotationDeg: rot, tagged: false };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('computePlacement — free placement', () => {
  it('drops a piece at the click point when there is no existing track', () => {
    const p = computePlacement(300, 200, 'straight', []);
    expect(p).toEqual({ x: 300, y: 200, rotationDeg: 0, connected: false });
  });

  it('snaps a device piece (train) onto the nearest point on the rail, where dropped', () => {
    const straight = piece('s1', 'straight', 450, 300, 0); // rail along y=300, x∈[350,550]
    // Drop a train at (500,300) — on the rail. It stays WHERE DROPPED on the rail
    // (x≈500), not jerked to the piece centre (450). Riding the rail, not the centre.
    const p = computePlacement(500, 300, 'train', [straight]);
    expect(p.connected).toBe(true);
    expect(p.x).toBe(500);
    expect(p.y).toBe(300);
  });

  it('drops a device piece (train) free when no marker is within snap range', () => {
    const straight = piece('s1', 'straight', 450, 300, 0);
    // Far from the only marker (450, 300): drops where clicked, unrotated.
    const p = computePlacement(900, 300, 'train', [straight]);
    expect(p).toEqual({ x: 900, y: 300, rotationDeg: 0, connected: false });
  });

  it('drops free when the click is beyond the capture radius of any endpoint', () => {
    const straight = piece('s1', 'straight', 450, 300, 0);
    // East endpoint is at 550; click well past the capture radius.
    const p = computePlacement(550 + CONNECT_CAPTURE_MM + 20, 300, 'straight', [straight]);
    expect(p.rotationDeg).toBe(0);
    expect(p.x).toBe(550 + CONNECT_CAPTURE_MM + 20);
  });
});

describe('computePlacement — snap + orient', () => {
  it('snaps a straight onto another straight east endpoint, continuing the line', () => {
    const straight = piece('s1', 'straight', 450, 300, 0);
    // East endpoint at (550, 300), outgoing angle 0. Click just past it.
    const p = computePlacement(560, 300, 'straight', [straight]);
    // New straight's west endpoint (its entry) must coincide with (550, 300).
    const placed = piece('s2', 'straight', p.x, p.y, p.rotationDeg);
    const [entry] = getEndpoints(placed);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('unreachable');
    expect(dist(entry, { x: 550, y: 300 })).toBeLessThan(0.5);
    // Continuing east means no rotation.
    expect(p.rotationDeg).toBe(0);
  });

  it('orients a curve to continue from a straight east endpoint', () => {
    const straight = piece('s1', 'straight', 450, 300, 0);
    const p = computePlacement(560, 300, 'curve', [straight]);
    const placed = piece('c1', 'curve', p.x, p.y, p.rotationDeg);
    const [entry] = getEndpoints(placed);
    if (entry === undefined) throw new Error('unreachable');
    // The curve's entry endpoint snaps exactly onto the straight's east end.
    expect(dist(entry, { x: 550, y: 300 })).toBeLessThan(0.5);
    // Curve entry local angle is 180; straight outgoing is 0 ⇒ no rotation.
    expect(p.rotationDeg).toBe(0);
  });
});

describe('computeMovePlacement — snaps on endpoint proximity, not centre', () => {
  it('snaps a dragged straight when its END reaches a joint though its CENTRE is out of capture', () => {
    const anchor = piece('a1', 'straight', 450, 300, 0); // east end at (550, 300)
    const moving = piece('m1', 'straight', 0, 0, 0);
    // Cursor so the moving straight's west end sits on (550, 300): centre at 650.
    const cursorX = 650;
    const cursorY = 300;
    // The centre is 100 mm from the joint — beyond capture — so the cursor-keyed
    // placement would NOT connect. This is exactly the case that failed before.
    expect(computePlacement(cursorX, cursorY, 'straight', [anchor]).connected).toBe(false);
    // But the move placement snaps because the piece's END is right on the joint.
    const p = computeMovePlacement(moving, cursorX, cursorY, [anchor]);
    expect(p.connected).toBe(true);
    const placed = piece('m1', 'straight', p.x, p.y, p.rotationDeg);
    const [entry] = getEndpoints(placed);
    if (entry === undefined) throw new Error('unreachable');
    expect(dist(entry, { x: 550, y: 300 })).toBeLessThan(0.5);
  });

  it('drops free and keeps current rotation when no end is near a joint', () => {
    const anchor = piece('a1', 'straight', 450, 300, 0);
    const moving = piece('m1', 'curve', 0, 0, 90);
    const p = computeMovePlacement(moving, 200, 100, [anchor]);
    expect(p.connected).toBe(false);
    expect(p).toMatchObject({ x: 200, y: 100, rotationDeg: 90 });
  });

  it('does NOT fling the piece across a joint when only its FAR end grazes capture', () => {
    /*
     * Teleport regression. A straight dragged to (420,220): its EAST end (520,220)
     * is ~50 mm from the anchor's east open end (550,300→ here 550,180), within
     * capture — but snapping that far end would fling the whole piece to the OTHER
     * side of the joint (centre ~650,180), ~230 mm from the cursor. That reads as
     * the piece "teleporting to the end of some track". The move must instead keep
     * the piece under the cursor (drop free), snapping only once the cursor is
     * dragged near where the piece will actually land.
     */
    const anchor = piece('a1', 'straight', 450, 180, 0); // east open end at (550,180)
    const moving = piece('m1', 'straight', 0, 0, 0);
    const cursorX = 420;
    const cursorY = 220;
    const p = computeMovePlacement(moving, cursorX, cursorY, [anchor]);
    /* It must not jump far from the cursor. */
    expect(Math.hypot(p.x - cursorX, p.y - cursorY)).toBeLessThan(CONNECT_CAPTURE_MM);
  });

  it('still snaps when the cursor IS near where the piece lands (no fling)', () => {
    /* The sensible case: drag the piece to roughly where it should extend the
       chain (cursor near the landing spot) — it snaps flush. */
    const anchor = piece('a1', 'straight', 450, 180, 0); // east open end at (550,180)
    const moving = piece('m1', 'straight', 0, 0, 0);
    /* Cursor at (650,180): the piece centred here has its west end on the joint
       and lands centred at ~650 — right under the cursor. */
    const p = computeMovePlacement(moving, 650, 180, [anchor]);
    expect(p.connected).toBe(true);
    const placed = piece('m1', 'straight', p.x, p.y, p.rotationDeg);
    const [entry] = getEndpoints(placed);
    if (entry === undefined) throw new Error('unreachable');
    expect(dist(entry, { x: 550, y: 180 })).toBeLessThan(0.5);
  });

  it('snaps a moved device piece (train) onto the nearest point on the rail, where dropped', () => {
    const anchor = piece('a1', 'straight', 450, 300, 0); // rail along y=300, x∈[350,550]
    const train = piece('t1', 'train', 0, 0, 0);
    // Drag the train to (480,300) on the rail — it stays NEAR the drop on the rail
    // (x≈480), not jerked to the piece centre (450).
    const p = computeMovePlacement(train, 480, 300, [anchor]);
    expect(p.connected).toBe(true);
    expect(Math.abs(p.x - 480), `landed at ${p.x}, not near the drop (480)`).toBeLessThan(20);
    expect(p.y).toBe(300);
  });

  it('drops a moved device piece free, keeping rotation, when no marker is near', () => {
    const anchor = piece('a1', 'straight', 450, 300, 0);
    const train = piece('t1', 'train', 0, 0, 90);
    const p = computeMovePlacement(train, 900, 300, [anchor]);
    expect(p.connected).toBe(false);
    expect(p).toMatchObject({ x: 900, y: 300, rotationDeg: 90 });
  });
});

describe('device snap invariant — placement point == spawn point (no pop)', () => {
  it('a snapped train placement is the exact marker the simulator spawns it on', () => {
    // Two adjacent straights so the layout has a marker WITH an outgoing edge.
    const a = piece('a', 'straight', 300, 300, 0); // exit at (400,300)
    const b = piece('b', 'straight', 500, 300, 0); // entry at (400,300) — adjacent
    const track = [a, b];

    // Drop a train at (330,300) — on piece A's rail, near its marker end.
    const placement = computePlacement(330, 300, 'train', track);
    expect(placement.connected).toBe(true);
    // It snapped onto the RAIL where dropped (x≈330, on y=300) — not jerked to a
    // centre — and stays on A's segment.
    expect(Math.abs(placement.x - 330), `landed at ${placement.x}`).toBeLessThan(40);
    expect(placement.y).toBe(300);

    // Drive the REAL spawn selector at the snapped position: it must STILL resolve
    // to marker M-a (the marker nearest the on-rail placement), so the train spawns
    // onto the right edge with no pop — the toy-table seats the body via
    // seatNearest(piece.position), which is this same on-rail point.
    const layout = compileLayout(track, 'inv');
    const startEdge = nearestStartEdge(layout, { x: placement.x, y: placement.y });
    expect(startEdge).toBeDefined();
    expect(startEdge?.from_marker_id).toBe('M-a');
  });

  it('a train dropped far from any track stays free (no snap, deferred spawn)', () => {
    const a = piece('a', 'straight', 300, 300, 0);
    const placement = computePlacement(800, 100, 'train', [a]);
    expect(placement.connected).toBe(false);
    expect(placement.x).toBe(800);
    expect(placement.y).toBe(100);
  });
});

describe('computePlacement — eight curves close into a circle', () => {
  it('chains eight curves clicked end-to-end into a closed loop', () => {
    const pieces: TrackPiece[] = [];

    // First curve placed in open space.
    const first = computePlacement(450, 300, 'curve', pieces);
    pieces.push(piece('c0', 'curve', first.x, first.y, first.rotationDeg));

    // Each subsequent curve is "clicked" on the previous curve's open exit.
    for (let i = 1; i < 8; i++) {
      const prev = pieces[i - 1];
      if (prev === undefined) throw new Error('unreachable');
      const exit = getEndpoints(prev)[1];
      if (exit === undefined) throw new Error('unreachable');
      const placement = computePlacement(exit.x, exit.y, 'curve', pieces);
      pieces.push(piece(`c${i}`, 'curve', placement.x, placement.y, placement.rotationDeg));
    }

    // The loop closes: the last curve's exit returns to the first curve's entry.
    const firstEntry = getEndpoints(pieces[0] as TrackPiece)[0];
    const lastExit = getEndpoints(pieces[7] as TrackPiece)[1];
    if (firstEntry === undefined || lastExit === undefined) throw new Error('unreachable');
    expect(dist(firstEntry, lastExit)).toBeLessThan(1);

    // Compiled into a layout it is a single connected ring: 8 markers, and
    // every marker has both an inbound and an outbound edge.
    const layout = compileLayout(pieces, 'circle');
    expect(layout.markers).toHaveLength(8);
    for (const marker of layout.markers) {
      const outbound = layout.edges.some((e) => e.from_marker_id === marker.id);
      const inbound = layout.edges.some((e) => e.to_marker_id === marker.id);
      expect(outbound, `${marker.id} has an outbound edge`).toBe(true);
      expect(inbound, `${marker.id} has an inbound edge`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer-gated snapping — a piece authored on one deck must not connect to a
// joint on another beneath it. The ramp is the sole legitimate cross-layer link.
// ---------------------------------------------------------------------------

describe('computePlacement — layer gating', () => {
  it('connects to a same-layer joint (ground straight, ground placement)', () => {
    // A ground straight at (0,0) has an open end at (100,0). Placing another
    // ground straight whose click lands near (100,0) snaps onto it.
    const ground = piece('g1', 'straight', 0, 0, 0);
    const p = computePlacement(100, 0, 'straight', [ground], false, 0);
    expect(p.connected).toBe(true);
  });

  it('does NOT connect to a ground joint when authoring on layer 1', () => {
    // Same ground joint at (100,0), but the new piece is on the UPPER deck.
    // The layer gate keeps it free — an upper-deck piece ignores ground joints
    // directly beneath it (the bridge requirement).
    const ground = piece('g1', 'straight', 0, 0, 0);
    const p = computePlacement(100, 0, 'straight', [ground], false, 1);
    expect(p.connected).toBe(false);
  });

  it('connects to an upper joint when authoring on layer 1', () => {
    // An upper straight at (0,0) on layer 1 has an open end at (100,0). Placing
    // another layer-1 straight near it connects.
    const upper: TrackPiece = {
      id: 'u1',
      type: 'straight',
      position: { x: 0, y: 0 },
      rotationDeg: 0,
      tagged: false,
      layer: 1,
    };
    const p = computePlacement(100, 0, 'straight', [upper], false, 1);
    expect(p.connected).toBe(true);
  });

  it('a device dropped on the upper deck snaps to the upper marker, not the ground marker beneath it', () => {
    // Ground straight and upper straight share the SAME centre (300,300). A
    // train dropped there on layer 1 must snap to the upper marker's centre
    // (same coords here, but the gate proves it ignored the ground piece).
    const ground = piece('g1', 'straight', 300, 300, 0);
    const upper: TrackPiece = {
      id: 'u1',
      type: 'straight',
      position: { x: 300, y: 300 },
      rotationDeg: 0,
      tagged: false,
      layer: 1,
    };
    const onUpper = computePlacement(300, 300, 'train', [ground, upper], false, 1);
    expect(onUpper.connected).toBe(true);
    // With only a ground piece present, an upper-layer train finds no marker.
    const noUpper = computePlacement(300, 300, 'train', [ground], false, 1);
    expect(noUpper.connected).toBe(false);
  });
});

describe('30 mm straight snapping', () => {
  it('treats both ends of a 30 mm straight as open snap targets', () => {
    /* A lone 30 mm straight at the origin, lying along x (ends at -15 and +15). */
    const existing: TrackPiece = {
      id: 'S30',
      type: 'straight',
      position: { x: 0, y: 0 },
      rotationDeg: 0,
      tagged: false,
      lengthMm: 30,
    };
    /* Dropping a new straight near the +15 end must snap (connect) to it. */
    const placement = computePlacement(15, 0, 'straight', [existing], false, 0);
    expect(placement.connected).toBe(true);
    /* And near the -15 end must also snap. */
    const placement2 = computePlacement(-15, 0, 'straight', [existing], false, 0);
    expect(placement2.connected).toBe(true);
  });
});

describe('length-variant straight snaps FLUSH', () => {
  it('a 110 mm straight snapped onto a neighbour meets it with no gap', () => {
    /* A default 200 mm straight at the origin: its east endpoint is at (100,0). */
    const anchor: TrackPiece = {
      id: 'A',
      type: 'straight',
      position: { x: 0, y: 0 },
      rotationDeg: 0,
      tagged: false,
    };
    const anchorEast = getEndpoints(anchor)[1];
    if (anchorEast === undefined) throw new Error('no east endpoint');

    /* Place a 110 mm straight by clicking on the anchor's east end. Because the
       candidate's own half-length (55 mm, not 100 mm) sets where its centre must
       sit for its entry to land on the anchor, computePlacement MUST receive the
       length — otherwise it positions a 200 mm centre and the 110 mm piece's
       entry lands ~45 mm short of the joint. */
    const placement = computePlacement(
      anchorEast.x,
      anchorEast.y,
      'straight',
      [anchor],
      false,
      0,
      110,
    );
    expect(placement.connected).toBe(true);

    const placed: TrackPiece = {
      id: 'B',
      type: 'straight',
      position: { x: placement.x, y: placement.y },
      rotationDeg: placement.rotationDeg,
      tagged: false,
      lengthMm: 110,
    };
    const placedWest = getEndpoints(placed)[0];
    if (placedWest === undefined) throw new Error('no west endpoint');

    /* The 110 mm piece's entry coincides with the anchor's east end. */
    const gap = Math.hypot(placedWest.x - anchorEast.x, placedWest.y - anchorEast.y);
    expect(gap).toBeLessThan(0.001);
  });
});
