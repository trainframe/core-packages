import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { LayoutState } from './layout-state.js';

/**
 * Simple loop: M1 -- M2 -- M3 -- M4 -- M1
 */
const SIMPLE_LOOP: Layout = {
  name: 'simple-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
    { id: 'M4', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2' },
    { from_marker_id: 'M2', to_marker_id: 'M3' },
    { from_marker_id: 'M3', to_marker_id: 'M4' },
    { from_marker_id: 'M4', to_marker_id: 'M1' },
  ],
  junctions: [],
};

describe('LayoutState constructor', () => {
  it('throws when an edge references a marker that is not in the markers list', () => {
    const broken: Layout = {
      name: 'broken',
      markers: [{ id: 'M1', kind: 'block_boundary' }],
      edges: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
      junctions: [],
    };
    expect(() => new LayoutState(broken)).toThrow(/unknown marker: M1 -> M2/);
  });
});

// ---------------------------------------------------------------------------
// Learned traversal time (EWMA)
// ---------------------------------------------------------------------------

describe('LayoutState.getLearnedTraversalMs', () => {
  it('returns undefined for an edge that has never been traversed', () => {
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => 0 });
    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBeUndefined();
  });

  it('returns undefined after the first traversal (no prior timestamp to diff)', () => {
    let t = 0;
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => t });

    t = 0;
    layout.recordTraversal('M1', 'M2');

    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBeUndefined();
  });

  it('sets learned ms to the raw delta on the second traversal of the same edge', () => {
    // now sequence: 0, 1000, 2050, 3100
    // Call 1 (t=0):    lastRecordedAt=null → no update. lastRecordedAt=0.
    // Call 2 (t=1000): delta=1000, no prior → learned=1000.
    // Call 3 (t=2050): delta=1050, prior=1000 → EWMA = 1000*0.7 + 1050*0.3 = 1015.
    // Call 4 (t=3100): delta=1050, prior=1015 → EWMA = 1015*0.7 + 1050*0.3 = 1025.5.
    const times = [0, 1000, 2050, 3100];
    let callIdx = 0;
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => times[callIdx++] ?? 0 });

    layout.recordTraversal('M1', 'M2'); // t=0, no delta
    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBeUndefined();

    layout.recordTraversal('M1', 'M2'); // t=1000, delta=1000 → learned=1000
    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBe(1000);

    layout.recordTraversal('M1', 'M2'); // t=2050, delta=1050 → EWMA=1015
    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBe(1015);

    layout.recordTraversal('M1', 'M2'); // t=3100, delta=1050 → EWMA=1025.5
    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBe(1025.5);
  });

  it('returns undefined for edges that have not been traversed, even after others are learned', () => {
    const times = [0, 1000];
    let callIdx = 0;
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => times[callIdx++] ?? 0 });

    layout.recordTraversal('M1', 'M2');
    layout.recordTraversal('M1', 'M2');

    expect(layout.getLearnedTraversalMs('M2', 'M3')).toBeUndefined();
    expect(layout.getLearnedTraversalMs('M3', 'M4')).toBeUndefined();
    expect(layout.getLearnedTraversalMs('M4', 'M1')).toBeUndefined();
  });

  it('attributes the delta to the current edge, not the previous one', () => {
    // t=0: record M1→M2, lastRecordedAt=null → no update. lastRecordedAt=0.
    // t=1000: record M2→M3, delta=1000 → M2→M3 learned=1000, NOT M1→M2.
    const times = [0, 1000];
    let callIdx = 0;
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => times[callIdx++] ?? 0 });

    layout.recordTraversal('M1', 'M2'); // first call, no delta
    layout.recordTraversal('M2', 'M3'); // delta=1000 attributed to M2→M3

    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBeUndefined();
    expect(layout.getLearnedTraversalMs('M2', 'M3')).toBe(1000);
  });

  it('does not advance lastRecordedAt on an unknown-marker early return', () => {
    // The early return for unknown markers exits before `now()` is called, so
    // `lastRecordedAt` must stay at the value set by the previous valid call.
    // With times [0, 1000]: call 1 (valid, t=0) sets lastRecordedAt=0 with no
    // delta; the BOGUS call exits early and consumes no clock tick; call 3
    // (valid, t=1000) computes delta = 1000 - 0 = 1000.
    // If the early return accidentally called now() first (with a hypothetical
    // t=9999 mid-sequence), the delta would be 1000 - 9999 < 0, so the timing
    // would be obviously wrong. By using only two timestamps we instead verify
    // that the BOGUS call does not consume a clock entry at all.
    const times = [0, 1000];
    let callIdx = 0;
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => times[callIdx++] ?? 0 });

    layout.recordTraversal('M1', 'M2'); // t=0, no delta, lastRecordedAt=0
    layout.recordTraversal('BOGUS', 'M2'); // unknown → early return, now() NOT called
    layout.recordTraversal('M1', 'M2'); // t=1000, delta=1000

    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Per-train EWMA tracking
// ---------------------------------------------------------------------------

describe('LayoutState per-train getLearnedTraversalMs', () => {
  it('returns undefined when no per-train or global value exists', () => {
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => 0 });
    expect(layout.getLearnedTraversalMs('M1', 'M2', 'express')).toBeUndefined();
  });

  it('falls back to global EWMA when no per-train value exists for trainId', () => {
    // Two traversals without a trainId to populate the global EWMA only.
    const times = [0, 1000];
    let callIdx = 0;
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => times[callIdx++] ?? 0 });

    layout.recordTraversal('M1', 'M2'); // global: first call, no delta
    layout.recordTraversal('M1', 'M2'); // global: delta=1000 → learned=1000

    // 'express' has no per-train value, so it falls back to global=1000.
    expect(layout.getLearnedTraversalMs('M1', 'M2', 'express')).toBe(1000);
  });

  it('per-train value takes precedence over global for the requesting train', () => {
    // Clock sequence (4 calls): 0, 500, 2000, 4000
    //   call 1 (t=0, shunter):    global: lastRecordedAt=null → no delta; lastRecordedAt=0.
    //                             shunter per-train: no prior → no delta; perTrain[shunter]=0.
    //   call 2 (t=500, shunter):  global: delta=500-0=500 → global=500; lastRecordedAt=500.
    //                             shunter: delta=500-0=500 → per-train=500; perTrain[shunter]=500.
    //   call 3 (t=2000, no id):   global: delta=2000-500=1500 → EWMA=500*0.7+1500*0.3=800; lastRecordedAt=2000.
    //   call 4 (t=4000, shunter): global: delta=4000-2000=2000 → EWMA=800*0.7+2000*0.3=1160.
    //                             shunter: delta=4000-500=3500 → EWMA=500*0.7+3500*0.3=1400.
    const times = [0, 500, 2000, 4000];
    let callIdx = 0;
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => times[callIdx++] ?? 0 });

    layout.recordTraversal('M1', 'M2', 'shunter'); // t=0: global no-delta, shunter no-delta
    layout.recordTraversal('M1', 'M2', 'shunter'); // t=500: global=500, shunter per-train=500
    layout.recordTraversal('M1', 'M2'); // t=2000: global EWMA=800 (no per-train update)
    layout.recordTraversal('M1', 'M2', 'shunter'); // t=4000: global EWMA=1160, shunter per-train EWMA=1400

    // Global value is updated by every call including trainId-attributed ones.
    expect(layout.getLearnedTraversalMs('M1', 'M2')).toBe(1160);
    // Shunter's per-train EWMA is driven only by shunter's own timestamps, so
    // it returns 1400 rather than the global 1160.
    expect(layout.getLearnedTraversalMs('M1', 'M2', 'shunter')).toBe(1400);
  });

  it('two trains on the same edge maintain independent EWMAs', () => {
    // Clock: 0, 1000, 2000, 3000, 4000, 5000
    // 'express' records at t=0 and t=1000 → per-train delta=1000.
    // 'shunter' records at t=2000 and t=5000 → per-train delta=3000.
    const times = [0, 1000, 2000, 5000];
    let callIdx = 0;
    const layout = new LayoutState(SIMPLE_LOOP, { now: () => times[callIdx++] ?? 0 });

    layout.recordTraversal('M1', 'M2', 'express'); // t=0: express no per-train delta
    layout.recordTraversal('M1', 'M2', 'express'); // t=1000: express per-train=1000
    layout.recordTraversal('M1', 'M2', 'shunter'); // t=2000: shunter no per-train delta
    layout.recordTraversal('M1', 'M2', 'shunter'); // t=5000: shunter per-train=3000

    expect(layout.getLearnedTraversalMs('M1', 'M2', 'express')).toBe(1000);
    expect(layout.getLearnedTraversalMs('M1', 'M2', 'shunter')).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// Pre-existing behaviour (smoke tests to ensure nothing regressed)
// ---------------------------------------------------------------------------

describe('LayoutState core graph operations', () => {
  it('finds edges in a pre-configured layout', () => {
    const layout = new LayoutState(SIMPLE_LOOP);
    expect(layout.findEdge('M1', 'M2')).toBeDefined();
    expect(layout.findEdge('M2', 'M1')).toBeUndefined();
  });

  it('infers and confirms edges by traversal count', () => {
    // Remove edge from layout first by using a fresh layout without M1→M2
    const partial: Layout = {
      name: 'partial',
      markers: SIMPLE_LOOP.markers,
      edges: SIMPLE_LOOP.edges.slice(1), // drop M1→M2
      junctions: [],
    };
    const ls = new LayoutState(partial, { confirmTraversals: 2 });
    expect(ls.findEdge('M1', 'M2')).toBeUndefined();

    const r1 = ls.recordTraversal('M1', 'M2');
    expect(r1.inferredEdgeAdded).toBe(true);
    expect(ls.findEdge('M1', 'M2')?.inferred).toBe(true);

    const r2 = ls.recordTraversal('M1', 'M2');
    expect(r2.edgeConfirmed).toBe(true);
    expect(ls.findEdge('M1', 'M2')?.inferred).toBe(false);
  });
});
