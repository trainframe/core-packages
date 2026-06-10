/**
 * Tests for VirtualTrain.getTrailingPosition() — consist trailing occupancy.
 * See ADR-016 (sim-side consist trailing occupancy, step 1).
 *
 * All tests drive the real simulation with fixed seeds; no mocking.
 */
import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';

/* 200 mm edges — the standard simple loop used throughout the suite. */
const SIMPLE_LOOP: Layout = {
  name: 'simple-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
    { id: 'M4', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

/* 100 mm edges — short enough that a modest offset crosses multiple edges. */
const SHORT_LOOP: Layout = {
  name: 'short-loop',
  markers: [
    { id: 'A', kind: 'block_boundary' },
    { id: 'B', kind: 'block_boundary' },
    { id: 'C', kind: 'block_boundary' },
    { id: 'D', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'A', to_marker_id: 'B', estimated_length_mm: 100 },
    { from_marker_id: 'B', to_marker_id: 'C', estimated_length_mm: 100 },
    { from_marker_id: 'C', to_marker_id: 'D', estimated_length_mm: 100 },
    { from_marker_id: 'D', to_marker_id: 'A', estimated_length_mm: 100 },
  ],
  junctions: [],
};

/* Ring used by ADR-015 exploration tests — 171 mm edges. */
const EXPLORE_RING: Layout = {
  name: 'explore-ring',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 171 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 171 },
    { from_marker_id: 'M3', to_marker_id: 'M1', estimated_length_mm: 171 },
  ],
  junctions: [],
};

/* Helpers ------------------------------------------------------------------ */

/* Advance a sim while waiting for a train to have moved some distance onto an
   edge that is NOT the spawn edge (i.e. a transition has occurred). Returns
   when the head is on an edge whose from-marker differs from the spawn edge's
   from-marker, or throws if the budget is exhausted. */
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
    if (edge && edge.from_marker_id !== spawnFromMarker) return;
    sim.advance(step);
    spent += step;
  }
  throw new Error(
    `advanceUntilTransitioned: train ${trainId} did not transition within ${budgetMs}ms`,
  );
}

/* =========================================================================
   getTrailingPosition — core semantics
   ========================================================================= */

describe('getTrailingPosition — trailing point on the same edge (mid-run)', () => {
  it('returns a point on the current edge when offset <= distance_into_edge', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
        { from_marker_id: 'M3', to_marker_id: 'M4' },
        { from_marker_id: 'M4', to_marker_id: 'M1' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M2' });

    /* Advance enough to be moving but still on M1→M2. */
    sim.advance(500);

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const dist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    if (!edge) throw new Error('expected train to be on an edge');

    /* A trailing offset of half the current distance stays on the same edge. */
    const offset = dist / 2;
    const pos = train.getTrailingPosition(offset);

    expect(pos).not.toBeNull();
    expect(pos?.edge.from_marker_id).toBe(edge.from_marker_id);
    expect(pos?.edge.to_marker_id).toBe(edge.to_marker_id);
    expect(pos?.distance_into_edge_mm).toBeCloseTo(dist - offset, 5);
  });
});

describe('getTrailingPosition — crossing onto the previous edge after a transition', () => {
  it('places the tail on the previous edge when offset > distance_into_current_edge', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
        { from_marker_id: 'M3', to_marker_id: 'M4' },
        { from_marker_id: 'M4', to_marker_id: 'M1' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M4' });

    /* Wait until the head has transitioned from M1→M2 onto M2→M3. */
    advanceUntilTransitioned(sim, 'T1', 'M1');

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const dist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    if (!edge) throw new Error('expected train to be on an edge');

    /* An offset that exceeds the current distance but fits inside the 200mm
       previous edge should resolve to M1→M2 at (200 - remaining). */
    const offset = dist + 50; // 50 mm back into previous 200mm edge
    const pos = train.getTrailingPosition(offset);

    expect(pos).not.toBeNull();
    expect(pos?.edge.from_marker_id).toBe('M1');
    expect(pos?.edge.to_marker_id).toBe('M2');
    expect(pos?.distance_into_edge_mm).toBeCloseTo(200 - 50, 5);
  });
});

describe('getTrailingPosition — station departure keeps the arrival edge', () => {
  it('records the just-traversed edge when a parked train is replanned onward', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'in',
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M3' });

    // Run in and PARK at the station M3 (the end of the M2→M3 arrival edge).
    let spent = 0;
    for (; spent < 30_000; spent += 50) {
      const t = sim.getTrain('T1');
      const e = t?.getCurrentEdge();
      if (
        e?.to_marker_id === 'M3' &&
        (t?.getDistanceIntoEdge() ?? 0) >= 200 &&
        t?.getVelocity() === 0
      )
        break;
      sim.advance(50);
    }
    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');
    expect(train.getCurrentEdge()).toEqual({ from_marker_id: 'M2', to_marker_id: 'M3' });

    // The scheduler replans the dwelling train onward from the station.
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'out',
      edges: [
        { from_marker_id: 'M3', to_marker_id: 'M4' },
        { from_marker_id: 'M4', to_marker_id: 'M1' },
      ],
    });

    // A wagon 50 mm behind the loco must sit on the ARRIVAL edge M2→M3 (at
    // 200 − 50), NOT skip back onto M1→M2. Before the fix the arrival edge was
    // dropped from the history on replan, so the whole rake jumped backward a
    // full edge the moment the train pulled out of the station.
    const pos = train.getTrailingPosition(50);
    expect(pos?.edge.from_marker_id).toBe('M2');
    expect(pos?.edge.to_marker_id).toBe('M3');
    expect(pos?.distance_into_edge_mm).toBeCloseTo(150, 5);
  });
});

describe('getTrailingPosition — spanning two edges back', () => {
  it('resolves a tail that spans two historical edges on a short-edge layout', () => {
    /* 100mm edges. Drive onto edge C→D; offset > (distance + 100 + something)
       so the tail lands in A→B (two edges back). */
    const sim = new Simulation({ layout: SHORT_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'A', to_marker_id: 'B' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [
        { from_marker_id: 'A', to_marker_id: 'B' },
        { from_marker_id: 'B', to_marker_id: 'C' },
        { from_marker_id: 'C', to_marker_id: 'D' },
        { from_marker_id: 'D', to_marker_id: 'A' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'D' });

    /* Wait until the head is on C→D (two transitions from spawn). */
    advanceUntilTransitioned(sim, 'T1', 'A');
    advanceUntilTransitioned(sim, 'T1', 'B');

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const dist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    if (!edge) throw new Error('expected train to be on C→D');
    expect(edge.from_marker_id).toBe('C');

    /* offset = dist + 100 (B→C) + 30 → lands 30mm into A→B, i.e. at 100-30=70. */
    const offset = dist + 100 + 30;
    const pos = train.getTrailingPosition(offset);

    expect(pos).not.toBeNull();
    expect(pos?.edge.from_marker_id).toBe('A');
    expect(pos?.edge.to_marker_id).toBe('B');
    expect(pos?.distance_into_edge_mm).toBeCloseTo(100 - 30, 5);
  });
});

describe('getTrailingPosition — graph walk-back when history is empty (closed loop)', () => {
  it('walks the layout graph backwards onto the real predecessor edges', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M2' });
    sim.advance(300); // still on M1→M2, now at the M2 end (dist 200)

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const dist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    expect(edge?.from_marker_id).toBe('M1');

    /* A big offset with no history no longer piles at the edge start: it follows
       the loop backwards — M1 ← M4←M1(200) ← M3←M4(200) ← lands on M2→M3 with
       (700 − 200 dist − 200 − 200) = 100 mm remaining into it. A trailing
       carriage sits on real track behind the head, not on top of it. */
    const pos = train.getTrailingPosition(dist + 500);

    expect(pos).not.toBeNull();
    expect(pos?.edge.from_marker_id).toBe('M2');
    expect(pos?.edge.to_marker_id).toBe('M3');
    expect(pos?.distance_into_edge_mm).toBe(100);
  });
});

describe('getTrailingPosition — continues past history onto graph predecessors', () => {
  it('walks the loop backwards past the oldest historical edge', () => {
    /* Put exactly two edges of history, then ask for an offset larger than
       dist + edge2 + edge1 — the surplus now walks the loop instead of clamping. */
    const sim = new Simulation({ layout: SHORT_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'A', to_marker_id: 'B' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [
        { from_marker_id: 'A', to_marker_id: 'B' },
        { from_marker_id: 'B', to_marker_id: 'C' },
        { from_marker_id: 'C', to_marker_id: 'D' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'D' });

    /* Wait until on C→D (two transitions). */
    advanceUntilTransitioned(sim, 'T1', 'A');
    advanceUntilTransitioned(sim, 'T1', 'B');

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const dist = train.getDistanceIntoEdge();

    /* offset = dist + 250. History (B→C 100, A→B 100) absorbs 200; the remaining
       50 walks one more predecessor back from A — the loop's D→A edge — landing
       at (100 − 50) = 50 mm into it. */
    const pos = train.getTrailingPosition(dist + 250);

    expect(pos).not.toBeNull();
    expect(pos?.edge.from_marker_id).toBe('D');
    expect(pos?.edge.to_marker_id).toBe('A');
    expect(pos?.distance_into_edge_mm).toBe(50);
  });
});

describe('getTrailingPosition — clamps at a genuine dead-end (no predecessor edge)', () => {
  it('clamps to the start of the oldest edge when the track does not continue back', () => {
    /* A LINE, not a loop: M1→M2→M3 with nothing leading INTO M1. A train on
       M1→M2 with a huge offset has no predecessor to walk onto, so it clamps at
       the start of its edge — the original spawn-time behaviour, preserved for
       open track. */
    const LINE: Layout = {
      name: 'line',
      markers: [
        { id: 'M1', kind: 'block_boundary' },
        { id: 'M2', kind: 'block_boundary' },
        { id: 'M3', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
        { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
      ],
      junctions: [],
    };
    const sim = new Simulation({ layout: LINE, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const pos = train.getTrailingPosition(500); // no history, no predecessor into M1
    expect(pos).not.toBeNull();
    expect(pos?.edge.from_marker_id).toBe('M1');
    expect(pos?.edge.to_marker_id).toBe('M2');
    expect(pos?.distance_into_edge_mm).toBe(0);
  });
});

describe('getTrailingPosition — parked train trails along its last edge', () => {
  it('keeps a stopped (no current edge) train on the rail behind where it parked', () => {
    /* Single-edge route: M1→M2 only. Clearance to M3 (past the route end) so
       that crossing M2 triggers transitionToNextEdge's null branch — the train
       parks at M2 with current_edge = null. Rather than returning null (which
       would snap the rendered rake to static placement off the rail), it now
       trails from the END of its last edge, so a stopped train stays on track. */
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M3' });
    sim.advance(15_000);

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    expect(train.getCurrentEdge()).toBeNull();
    // Head (offset 0): parked at the M2 end of its last edge M1→M2 (200 mm).
    const head = train.getTrailingPosition(0);
    expect(head?.edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(head?.distance_into_edge_mm).toBe(200);
    // A carriage 50 mm back is still on M1→M2, on the rail behind the head.
    const car = train.getTrailingPosition(50);
    expect(car?.edge).toEqual({ from_marker_id: 'M1', to_marker_id: 'M2' });
    expect(car?.distance_into_edge_mm).toBe(150);
  });
});

describe('getTrailingPosition — offset 0 returns head position', () => {
  it('offset 0 returns the exact head position', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3' },
      ],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M3' });
    sim.advance(800);

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const dist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    if (!edge) throw new Error('expected train on edge');

    const pos = train.getTrailingPosition(0);

    expect(pos).not.toBeNull();
    expect(pos?.edge.from_marker_id).toBe(edge.from_marker_id);
    expect(pos?.edge.to_marker_id).toBe(edge.to_marker_id);
    expect(pos?.distance_into_edge_mm).toBe(dist);
  });
});

describe('getTrailingPosition — negative offset returns head position', () => {
  it('negative offset is treated as 0 and returns the head position', () => {
    const sim = new Simulation({ layout: SIMPLE_LOOP, seed: 1 });
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'assign_route', {
      route_id: 'r1',
      edges: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
    });
    sim.handleCommand('T1', 'grant_clearance', { limit_marker_id: 'M2' });
    sim.advance(600);

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const dist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    if (!edge) throw new Error('expected train on edge');

    const pos = train.getTrailingPosition(-10);

    expect(pos?.distance_into_edge_mm).toBe(dist);
    expect(pos?.edge.from_marker_id).toBe(edge.from_marker_id);
  });
});

describe('getTrailingPosition — exploration mode builds history', () => {
  it('getTrailingPosition resolves across an explored edge transition', () => {
    const sim = new Simulation({ layout: EXPLORE_RING, seed: 1 });
    sim.seedIdentityTags(EXPLORE_RING);
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'begin_exploration', { reason: 'discovery' });

    /* Advance until the head has left M1→M2 (first exploration transition). */
    advanceUntilTransitioned(sim, 'T1', 'M1');

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    const dist = train.getDistanceIntoEdge();
    const edge = train.getCurrentEdge();
    if (!edge) throw new Error('expected train on edge after exploration transition');

    /* The previous edge was M1→M2 (171mm). An offset crossing back into it
       should resolve to M1→M2 at (171 - remaining). */
    const offset = dist + 30; // 30mm back into M1→M2
    const pos = train.getTrailingPosition(offset);

    expect(pos).not.toBeNull();
    expect(pos?.edge.from_marker_id).toBe('M1');
    expect(pos?.edge.to_marker_id).toBe('M2');
    expect(pos?.distance_into_edge_mm).toBeCloseTo(171 - 30, 5);
  });
});

describe('getTrailingPosition — history cap (> 32 edges)', () => {
  it('history is bounded to 32 edges; a very large offset clamps to a valid layout edge at distance 0', () => {
    /* Use the 171mm explore ring. At 100mm/s a full lap takes ~5.1s; 33 laps
       → ~168s virtual time. Each lap crosses 3 edges → > 32 edges total. */
    const sim = new Simulation({ layout: EXPLORE_RING, seed: 1 });
    sim.seedIdentityTags(EXPLORE_RING);
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M2' } });
    sim.handleCommand('T1', 'begin_exploration', { reason: 'discovery' });

    /* 180 s virtual time → well past 32 edge crossings. */
    sim.advance(180_000);

    const train = sim.getTrain('T1');
    if (!train) throw new Error('train missing');

    /* Sanity: train is still exploring. */
    const edge = train.getCurrentEdge();
    expect(edge).not.toBeNull();

    /* A huge offset exhausts history and must clamp to the oldest entry,
       which is a real layout edge. */
    const pos = train.getTrailingPosition(1_000_000);

    expect(pos).not.toBeNull();
    if (!pos) throw new Error('unreachable');

    /* The clamped position must be at distance 0 on a real layout edge. */
    expect(pos.distance_into_edge_mm).toBe(0);
    const knownEdges = EXPLORE_RING.edges.map((e) => `${e.from_marker_id}->${e.to_marker_id}`);
    const resultEdge = `${pos.edge.from_marker_id}->${pos.edge.to_marker_id}`;
    expect(knownEdges).toContain(resultEdge);
  });
});
