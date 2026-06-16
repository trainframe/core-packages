/**
 * Unit + integration tests for `trailingCarriagePose` — the helper that maps
 * the sim's `getTrailingPosition` result to a world-space pose.
 *
 * Strategy (per CLAUDE.md): drive a real `Simulation` from @trainframe/simulator
 * with a hand-built layout whose marker IDs match the `M-{pieceId}` convention
 * used by `layout-from-pieces`. Build matching collinear straight `TrackPiece`
 * objects so `composeEdgePath` produces a clean linear path — then geometry
 * assertions are predictable. No mocking of the Simulation or the scheduler.
 */
import type { Layout } from '@trainframe/protocol';
import { Simulation } from '@trainframe/simulator';
import {
  type EdgePath,
  type TrailingPositionSource,
  composeEdgePath,
  trailingCarriagePose,
} from '@trainframe/simulator/track/edge-path.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { describe, expect, it } from 'vitest';

/* ---------------------------------------------------------------------------
   Fixtures
   --------------------------------------------------------------------------- */

/*
 * Three collinear straight pieces at x=0, x=200, x=400 (rotation 0°).
 * Marker IDs: M-pa, M-pb, M-pc — matching layout-from-pieces' M-{piece.id} form.
 * Adjacent pieces share a joint at x=100 and x=300 respectively, so
 * composeEdgePath produces a clean 200mm linear path for each edge.
 */
const piecePa: TrackPiece = {
  id: 'pa',
  type: 'straight',
  position: { x: 0, y: 0 },
  rotationDeg: 0,
  tagged: false,
};
const piecePb: TrackPiece = {
  id: 'pb',
  type: 'straight',
  position: { x: 200, y: 0 },
  rotationDeg: 0,
  tagged: false,
};
const piecePc: TrackPiece = {
  id: 'pc',
  type: 'straight',
  position: { x: 400, y: 0 },
  rotationDeg: 0,
  tagged: false,
};

const piecesById = new Map<string, TrackPiece>([
  ['pa', piecePa],
  ['pb', piecePb],
  ['pc', piecePc],
]);

/*
 * Layout whose edges match the pieces above. Estimated lengths are 200mm — the
 * true straight length — so the sim-space → world-path rescaling is 1:1.
 */
const THREE_STRAIGHT_LAYOUT: Layout = {
  name: 'three-straight',
  markers: [
    { id: 'M-pa', kind: 'block_boundary' },
    { id: 'M-pb', kind: 'block_boundary' },
    { id: 'M-pc', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M-pa', to_marker_id: 'M-pb', estimated_length_mm: 200 },
    { from_marker_id: 'M-pb', to_marker_id: 'M-pc', estimated_length_mm: 200 },
    /* Reverse edges so the layout is navigable as a directed graph if needed. */
    { from_marker_id: 'M-pc', to_marker_id: 'M-pb', estimated_length_mm: 200 },
    { from_marker_id: 'M-pb', to_marker_id: 'M-pa', estimated_length_mm: 200 },
  ],
  junctions: [],
};

function estimatedLengthMm(fromMarkerId: string, toMarkerId: string): number {
  const edge = THREE_STRAIGHT_LAYOUT.edges.find(
    (e) => e.from_marker_id === fromMarkerId && e.to_marker_id === toMarkerId,
  );
  return edge?.estimated_length_mm ?? 200;
}

/* Mirror the helper from trailing-position.test.ts. */
function advanceUntilTransitioned(
  sim: Simulation,
  trainId: string,
  spawnFromMarker: string,
  budgetMs = 30_000,
): void {
  const step = 50;
  let spent = 0;
  while (spent < budgetMs) {
    const train = sim.getTrain(trainId);
    const edge = train?.getCurrentEdge();
    if (edge !== null && edge !== undefined && edge.from_marker_id !== spawnFromMarker) return;
    sim.advance(step);
    spent += step;
  }
  throw new Error(
    `advanceUntilTransitioned: train ${trainId} did not transition within ${budgetMs}ms`,
  );
}

/* ---------------------------------------------------------------------------
   Helper: same-edge mid-run
   --------------------------------------------------------------------------- */

describe('trailingCarriagePose — carriage on the same edge mid-run', () => {
  it('returns a pose strictly between edge start and head position when offset < headDist', () => {
    const sim = new Simulation({ layout: THREE_STRAIGHT_LAYOUT, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M-pa', to_marker_id: 'M-pb' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [
        { from_marker_id: 'M-pa', to_marker_id: 'M-pb' },
        { from_marker_id: 'M-pb', to_marker_id: 'M-pc' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M-pb' });
    /* Advance enough to be moving but still on M-pa→M-pb. */
    sim.advance(500);

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');
    const headDist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    if (!edge) throw new Error('expected train on edge');
    expect(edge.from_marker_id).toBe('M-pa');

    /* Compose the current-edge path and prime the cache. */
    const currentPath = composeEdgePath(piecePa, piecePb);
    const pathCache = new Map<string, EdgePath>([['M-pa->M-pb', currentPath]]);

    /* A 25mm offset keeps the carriage on the current edge. */
    const offset = 25;
    const pose = trailingCarriagePose(train, offset, piecesById, estimatedLengthMm, pathCache);

    expect(pose).toBeDefined();
    if (!pose) throw new Error('unreachable');

    /*
     * With estLen = path.length = 200mm (1:1), t = (headDist - 25) / 200.
     * For a 200mm linear path from (0,0) to (200,0), pose.x ≈ headDist - 25.
     */
    expect(pose.x).toBeGreaterThan(0);
    expect(pose.x).toBeLessThan(headDist); // strictly behind the head
    expect(pose.y).toBeCloseTo(0, 1); // stays on the horizontal rail
  });
});

/* ---------------------------------------------------------------------------
   Helper: carriage resolved onto the previous edge after a transition
   --------------------------------------------------------------------------- */

describe('trailingCarriagePose — carriage on the previous edge after transition', () => {
  it('returns a pose with x < 200 (boundary) when offset crosses the edge boundary', () => {
    const sim = new Simulation({ layout: THREE_STRAIGHT_LAYOUT, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M-pa', to_marker_id: 'M-pb' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [
        { from_marker_id: 'M-pa', to_marker_id: 'M-pb' },
        { from_marker_id: 'M-pb', to_marker_id: 'M-pc' },
      ],
    });
    /* Grant clearance through the boundary marker so the train crosses freely. */
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M-pc' });

    /* Advance until the head has crossed M-pb and is on M-pb→M-pc. */
    advanceUntilTransitioned(sim, 'T1', 'M-pa');

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');
    const headDist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    if (!edge) throw new Error('expected train on edge');
    expect(edge.from_marker_id).toBe('M-pb');

    /* Compose the current-edge path (M-pb→M-pc) and prime the cache. */
    const currentPath = composeEdgePath(piecePb, piecePc);
    const pathCache = new Map<string, EdgePath>([['M-pb->M-pc', currentPath]]);

    /* An offset that crosses back into the previous edge (M-pa→M-pb):
       offset = headDist + 50 → 50mm into M-pa→M-pb → at 200-50=150mm from M-pa. */
    const offset = headDist + 50;
    const pose = trailingCarriagePose(train, offset, piecesById, estimatedLengthMm, pathCache);

    expect(pose).toBeDefined();
    if (!pose) throw new Error('unreachable');

    /* The carriage is on M-pa→M-pb, so its x must be strictly less than
       piecePb.position.x (200), which is the boundary between the two edges.
       The old single-edge clamp would have pinned it AT 200; multi-edge places
       it genuinely behind at ~150. This is the key discriminating assertion. */
    expect(pose.x).toBeLessThan(200);
    expect(pose.x).toBeGreaterThan(0);
    /* The pose must be near x=150 (±5mm tolerance for path sampling). */
    expect(pose.x).toBeCloseTo(150, 0);
    expect(pose.y).toBeCloseTo(0, 1);

    /* Confirm the previous-edge path was added to the cache (compose-once). */
    expect(pathCache.has('M-pa->M-pb')).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
   Helper: fallback when a piece is missing from piecesById
   --------------------------------------------------------------------------- */

describe('trailingCarriagePose — fallback when endpoint piece is absent', () => {
  it("returns undefined when the previous edge's piece is not in piecesById", () => {
    const sim = new Simulation({ layout: THREE_STRAIGHT_LAYOUT, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M-pa', to_marker_id: 'M-pb' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [
        { from_marker_id: 'M-pa', to_marker_id: 'M-pb' },
        { from_marker_id: 'M-pb', to_marker_id: 'M-pc' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M-pc' });
    advanceUntilTransitioned(sim, 'T1', 'M-pa');

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');
    const headDist = train.getDistanceIntoEdge();

    /* A map missing piecePa so the previous-edge path cannot be composed. */
    const incompleteMap = new Map<string, TrackPiece>([
      ['pb', piecePb],
      ['pc', piecePc],
    ]);

    const currentPath = composeEdgePath(piecePb, piecePc);
    const pathCache = new Map<string, EdgePath>([['M-pb->M-pc', currentPath]]);

    const offset = headDist + 50; /* Crosses back into M-pa→M-pb. */
    const pose = trailingCarriagePose(train, offset, incompleteMap, estimatedLengthMm, pathCache);

    /* Cannot resolve M-pa → no piecePa in map → undefined (caller uses fallback). */
    expect(pose).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
   Helper: null from getTrailingPosition (train off track)
   --------------------------------------------------------------------------- */

describe('trailingCarriagePose — null when sim returns null', () => {
  it('returns undefined when getTrailingPosition returns null', () => {
    /* A minimal TrailingPositionSource stub that always returns null. */
    const offTrackTrain: TrailingPositionSource = {
      getTrailingPosition: () => null,
    };
    const currentPath = composeEdgePath(piecePa, piecePb);
    const pathCache = new Map<string, EdgePath>([['M-pa->M-pb', currentPath]]);

    const pose = trailingCarriagePose(offTrackTrain, 50, piecesById, estimatedLengthMm, pathCache);
    expect(pose).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
   Helper: carriage on the same edge at spawn (offset clamps to edge start)
   --------------------------------------------------------------------------- */

describe('trailingCarriagePose — carriage clamped to edge start at spawn', () => {
  it('returns the edge-start pose when offset exceeds distance at spawn (no history)', () => {
    /*
     * At spawn: distance_into_edge = 0, no traversal history.
     * getTrailingPosition(50) → clamp to current edge at distance 0.
     * With estLen=200, path.length≈200: t = 0/200 = 0, pose = path.at(0) = piecePa.position.
     */
    const sim = new Simulation({ layout: THREE_STRAIGHT_LAYOUT, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M-pa', to_marker_id: 'M-pb' } });

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const currentPath = composeEdgePath(piecePa, piecePb);
    const pathCache = new Map<string, EdgePath>([['M-pa->M-pb', currentPath]]);

    const pose = trailingCarriagePose(train, 50, piecesById, estimatedLengthMm, pathCache);

    expect(pose).toBeDefined();
    if (!pose) throw new Error('unreachable');

    /* Edge start = piecePa.position = (0, 0). */
    expect(pose.x).toBeCloseTo(0, 1);
    expect(pose.y).toBeCloseTo(0, 1);
  });
});
