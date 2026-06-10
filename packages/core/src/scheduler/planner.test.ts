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

/** A bidirectional square A-B-C-D-A (every connection both ways) — a real
 *  compiled layout looks like this. Reversing is structurally possible, so the
 *  directionality constraint has something to bite on. */
const bidiSquare = (): LayoutState =>
  new LayoutState(
    {
      name: 'bidi-square',
      markers: ['A', 'B', 'C', 'D'].map((id) => ({ id, kind: 'block_boundary' as const })),
      edges: [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'],
        ['D', 'A'],
      ].flatMap(([x, y]) => [
        { from_marker_id: x as string, to_marker_id: y as string, estimated_length_mm: 100 },
        { from_marker_id: y as string, to_marker_id: x as string, estimated_length_mm: 100 },
      ]),
      junctions: [],
    },
    { now: () => 0 },
  );

/** A bidirectional line A-B-C — a dead-end either way. */
const bidiLinear = (): LayoutState =>
  new LayoutState(
    {
      name: 'bidi-linear',
      markers: ['A', 'B', 'C'].map((id) => ({ id, kind: 'block_boundary' as const })),
      edges: [
        ['A', 'B'],
        ['B', 'C'],
      ].flatMap(([x, y]) => [
        { from_marker_id: x as string, to_marker_id: y as string, estimated_length_mm: 100 },
        { from_marker_id: y as string, to_marker_id: x as string, estimated_length_mm: 100 },
      ]),
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

  describe('directionality — no 180° flips', () => {
    it('without a heading, takes the shortest path even if it reverses', () => {
      // From A to D, the bare D→A back-edge is one hop; with no current edge the
      // planner is free to use it.
      expect(planTransit(bidiSquare(), 'A', 'D')).toEqual([
        { from_marker_id: 'A', to_marker_id: 'D' },
      ]);
    });

    it('a train mid-edge continues forward rather than flipping 180°', () => {
      // The train occupies A→B (heading B). To reach D it must go the long way
      // round the square (A→B→C→D), NOT reverse off its edge onto the one-hop
      // A→D back-edge.
      const path = planTransit(bidiSquare(), 'A', 'D', {
        from_marker_id: 'A',
        to_marker_id: 'B',
      });
      expect(path).toEqual([
        { from_marker_id: 'A', to_marker_id: 'B' },
        { from_marker_id: 'B', to_marker_id: 'C' },
        { from_marker_id: 'C', to_marker_id: 'D' },
      ]);
    });

    it('returns the current edge alone when it leads straight to the target', () => {
      const path = planTransit(bidiSquare(), 'A', 'B', {
        from_marker_id: 'A',
        to_marker_id: 'B',
      });
      expect(path).toEqual([{ from_marker_id: 'A', to_marker_id: 'B' }]);
    });

    it('stopped at a marker, leaves any way but straight back the way it came', () => {
      // The train arrived at B via A→B and is now at B. Reaching A must go the
      // long way (B→C→D→A), not the one-hop U-turn B→A.
      const path = planTransit(bidiSquare(), 'B', 'A', {
        from_marker_id: 'A',
        to_marker_id: 'B',
      });
      expect(path).toEqual([
        { from_marker_id: 'B', to_marker_id: 'C' },
        { from_marker_id: 'C', to_marker_id: 'D' },
        { from_marker_id: 'D', to_marker_id: 'A' },
      ]);
    });

    it('returns null when the target is only reachable by reversing (dead-end line)', () => {
      // The train occupies B→C (heading C, a dead end). Reaching A would require
      // flipping 180°, which ordinary routing refuses — so: no path. (An explicit
      // grant_reverse is the separate, gated way back.)
      expect(
        planTransit(bidiLinear(), 'B', 'A', { from_marker_id: 'B', to_marker_id: 'C' }),
      ).toBeNull();
    });
  });

  describe('turnout topology — no leg-to-leg (exit-to-exit) moves', () => {
    /** A single turnout: trunk T, junction J, two switched legs L1 (main) and
     *  L2 (divert). The legs join the trunk, never each other. */
    const turnout = (): LayoutState =>
      new LayoutState(
        {
          name: 'turnout',
          markers: [
            { id: 'T', kind: 'block_boundary' },
            { id: 'J', kind: 'junction' },
            { id: 'L1', kind: 'block_boundary' },
            { id: 'L2', kind: 'block_boundary' },
          ],
          edges: [
            { from_marker_id: 'T', to_marker_id: 'J', estimated_length_mm: 100 },
            { from_marker_id: 'J', to_marker_id: 'T', estimated_length_mm: 100 },
            {
              from_marker_id: 'J',
              to_marker_id: 'L1',
              estimated_length_mm: 100,
              requires_switch_state: 'main',
            },
            { from_marker_id: 'L1', to_marker_id: 'J', estimated_length_mm: 100 },
            {
              from_marker_id: 'J',
              to_marker_id: 'L2',
              estimated_length_mm: 100,
              requires_switch_state: 'divert',
            },
            { from_marker_id: 'L2', to_marker_id: 'J', estimated_length_mm: 100 },
          ],
          junctions: [{ marker_id: 'J', initial_state: 'main' }],
        },
        { now: () => 0 },
      );

    it('a train that entered the junction on one leg cannot cross to the other', () => {
      // Arrived at J via L1→J (a leg). L2 is the OTHER leg — reaching it would be
      // an exit-to-exit move, which a turnout can't do, so: no path (reversing
      // back out via the trunk is the separate, gated manoeuvre).
      expect(
        planTransit(turnout(), 'J', 'L2', { from_marker_id: 'L1', to_marker_id: 'J' }),
      ).toBeNull();
    });

    it('trunk → leg is allowed', () => {
      expect(planTransit(turnout(), 'T', 'L1')).toEqual([
        { from_marker_id: 'T', to_marker_id: 'J' },
        { from_marker_id: 'J', to_marker_id: 'L1' },
      ]);
    });

    it('leg → trunk is allowed', () => {
      expect(
        planTransit(turnout(), 'L1', 'T', { from_marker_id: 'X', to_marker_id: 'L1' }),
      ).toEqual([
        { from_marker_id: 'L1', to_marker_id: 'J' },
        { from_marker_id: 'J', to_marker_id: 'T' },
      ]);
    });

    it('a train heading INTO the junction on a leg continues to the trunk, never the other leg', () => {
      // Mid-edge L1→J (heading J). Target T sits past the trunk; the route must
      // be L1→J→T, never L1→J→L2.
      const path = planTransit(turnout(), 'L1', 'T', { from_marker_id: 'L1', to_marker_id: 'J' });
      expect(path).toEqual([
        { from_marker_id: 'L1', to_marker_id: 'J' },
        { from_marker_id: 'J', to_marker_id: 'T' },
      ]);
    });
  });
});
