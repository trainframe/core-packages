import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { LayoutState } from './layout-state.js';
import { planTransit } from './planner.js';

const linear = (): LayoutState =>
  new LayoutState(
    {
      name: 'linear',
      markers: [
        { id: 'A', kind: 'block_boundary' },
        { id: 'B', kind: 'block_boundary' },
        { id: 'C', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'A', to_marker_id: 'B', estimated_length_mm: 100 },
        { from_marker_id: 'B', to_marker_id: 'C', estimated_length_mm: 100 },
      ],
      junctions: [],
    },
    { now: () => 0 },
  );

/**
 * Two paths from A to D: a long one A→B→D (300mm) and a short one A→C→D
 * (110mm). Dijkstra by length should pick A→C→D.
 */
const branchedByLength = (): LayoutState =>
  new LayoutState(
    {
      name: 'branched-by-length',
      markers: [
        { id: 'A', kind: 'block_boundary' },
        { id: 'B', kind: 'block_boundary' },
        { id: 'C', kind: 'block_boundary' },
        { id: 'D', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'A', to_marker_id: 'B', estimated_length_mm: 200 },
        { from_marker_id: 'B', to_marker_id: 'D', estimated_length_mm: 100 },
        { from_marker_id: 'A', to_marker_id: 'C', estimated_length_mm: 50 },
        { from_marker_id: 'C', to_marker_id: 'D', estimated_length_mm: 60 },
      ],
      junctions: [],
    },
    { now: () => 0 },
  );

/**
 * A directed cycle. Planner must terminate, not loop forever.
 *
 *   A → B → C → A     (cycle)
 *           ↓
 *           D         (target only reachable from C)
 */
const cyclicWithBranch = (): LayoutState =>
  new LayoutState(
    {
      name: 'cyclic',
      markers: [
        { id: 'A', kind: 'block_boundary' },
        { id: 'B', kind: 'block_boundary' },
        { id: 'C', kind: 'block_boundary' },
        { id: 'D', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'A', to_marker_id: 'B', estimated_length_mm: 100 },
        { from_marker_id: 'B', to_marker_id: 'C', estimated_length_mm: 100 },
        { from_marker_id: 'C', to_marker_id: 'A', estimated_length_mm: 100 },
        { from_marker_id: 'C', to_marker_id: 'D', estimated_length_mm: 100 },
      ],
      junctions: [],
    },
    { now: () => 0 },
  );

/** Two isolated subgraphs. No path between them; planner returns null. */
const disconnected = (): LayoutState =>
  new LayoutState(
    {
      name: 'disconnected',
      markers: [
        { id: 'A', kind: 'block_boundary' },
        { id: 'B', kind: 'block_boundary' },
        { id: 'X', kind: 'block_boundary' },
        { id: 'Y', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'A', to_marker_id: 'B', estimated_length_mm: 100 },
        { from_marker_id: 'X', to_marker_id: 'Y', estimated_length_mm: 100 },
      ],
      junctions: [],
    },
    { now: () => 0 },
  );

describe('planTransit', () => {
  it('returns the unique path on a simple linear layout', () => {
    const path = planTransit(linear(), 'A', 'C');
    expect(path).toEqual([
      { from_marker_id: 'A', to_marker_id: 'B' },
      { from_marker_id: 'B', to_marker_id: 'C' },
    ]);
  });

  it('chooses the shortest-by-length path when alternatives exist', () => {
    const path = planTransit(branchedByLength(), 'A', 'D');
    // A→C→D = 110mm, A→B→D = 300mm. Dijkstra picks the cheaper one.
    expect(path).toEqual([
      { from_marker_id: 'A', to_marker_id: 'C' },
      { from_marker_id: 'C', to_marker_id: 'D' },
    ]);
  });

  it('returns an empty transit when source equals target', () => {
    // The scheduler is responsible for skipping the empty case; the planner
    // just reports "you are already there".
    expect(planTransit(linear(), 'B', 'B')).toEqual([]);
  });

  it('returns null when the target is structurally unreachable', () => {
    expect(planTransit(disconnected(), 'A', 'Y')).toBeNull();
  });

  it('returns null when either marker is unknown to the layout', () => {
    expect(planTransit(linear(), 'A', 'NOPE')).toBeNull();
    expect(planTransit(linear(), 'NOPE', 'C')).toBeNull();
  });

  it('terminates on cyclic graphs without revisiting settled nodes', () => {
    const path = planTransit(cyclicWithBranch(), 'A', 'D');
    // Path must traverse A→B→C→D (the cycle back-edge C→A is irrelevant).
    expect(path).toEqual([
      { from_marker_id: 'A', to_marker_id: 'B' },
      { from_marker_id: 'B', to_marker_id: 'C' },
      { from_marker_id: 'C', to_marker_id: 'D' },
    ]);
  });

  it('treats edges without an estimated length as cost 1 (falls back to hop-count)', () => {
    const layout = new LayoutState(
      {
        name: 'unweighted',
        markers: [
          { id: 'A', kind: 'block_boundary' },
          { id: 'B', kind: 'block_boundary' },
          { id: 'C', kind: 'block_boundary' },
          { id: 'D', kind: 'block_boundary' },
        ],
        // Two-hop and three-hop paths. Without lengths, two-hop wins (cost 2).
        edges: [
          { from_marker_id: 'A', to_marker_id: 'B' },
          { from_marker_id: 'B', to_marker_id: 'D' },
          { from_marker_id: 'A', to_marker_id: 'C' },
          { from_marker_id: 'C', to_marker_id: 'B' },
        ],
        junctions: [],
      },
      { now: () => 0 },
    );
    expect(planTransit(layout, 'A', 'D')).toEqual([
      { from_marker_id: 'A', to_marker_id: 'B' },
      { from_marker_id: 'B', to_marker_id: 'D' },
    ]);
  });

  it('ignores switch position state — purely structural pathfinding', () => {
    // A junction marker J with two outgoing edges, requires_switch_state
    // tagged so a runtime-aware pathfinder would exclude one. The planner
    // must ignore that and pick the shortest edge.
    const layout = new LayoutState(
      {
        name: 'junction-blind',
        markers: [
          { id: 'A', kind: 'block_boundary' },
          { id: 'J', kind: 'junction' },
          { id: 'M', kind: 'block_boundary' },
          { id: 'S', kind: 'block_boundary' },
        ],
        edges: [
          { from_marker_id: 'A', to_marker_id: 'J', estimated_length_mm: 100 },
          // The 'divert' path is shorter; switch is set to 'main', but the
          // planner doesn't look at that and should pick divert anyway.
          {
            from_marker_id: 'J',
            to_marker_id: 'S',
            estimated_length_mm: 50,
            requires_switch_state: 'divert',
          },
          {
            from_marker_id: 'J',
            to_marker_id: 'M',
            estimated_length_mm: 200,
            requires_switch_state: 'main',
          },
        ],
        junctions: [{ marker_id: 'J', initial_state: 'main' }],
      },
      { now: () => 0 },
    );
    const path = planTransit(layout, 'A', 'S');
    expect(path).toEqual([
      { from_marker_id: 'A', to_marker_id: 'J' },
      { from_marker_id: 'J', to_marker_id: 'S' },
    ]);
  });
});
