import { describe, expect, it } from 'vitest';
import { compileLayout } from './layout-from-pieces.js';
import { type RotationDeg, type TrackPiece, getEndpoints } from './pieces.js';
import { CONNECT_CAPTURE_MM, computeMovePlacement, computePlacement } from './placement.js';

function piece(
  id: string,
  type: TrackPiece['type'],
  x: number,
  y: number,
  rot: RotationDeg,
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

  it('drops a device piece (train) at the click point even near an endpoint', () => {
    const straight = piece('s1', 'straight', 450, 300, 0);
    // Click right on the straight's east endpoint (550, 300).
    const p = computePlacement(550, 300, 'train', [straight]);
    expect(p).toEqual({ x: 550, y: 300, rotationDeg: 0, connected: false });
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

  it('never snaps a device piece — a train has no endpoints', () => {
    const anchor = piece('a1', 'straight', 450, 300, 0);
    const train = piece('t1', 'train', 0, 0, 0);
    // Cursor right on the joint; a train still drops free (no track topology).
    const p = computeMovePlacement(train, 550, 300, [anchor]);
    expect(p.connected).toBe(false);
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
