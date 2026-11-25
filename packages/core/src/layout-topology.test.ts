import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { LayoutState } from './scheduler/layout-state.js';
import { planTransit } from './scheduler/planner.js';

const TURNOUT: Layout = {
  name: 'turnout',
  markers: [
    { id: 'TRUNK', kind: 'block_boundary' },
    { id: 'JCT', kind: 'junction' },
    { id: 'LEG_A', kind: 'block_boundary' },
    { id: 'LEG_B', kind: 'block_boundary' },
    { id: 'ORPHAN', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'TRUNK', to_marker_id: 'JCT' },
    { from_marker_id: 'JCT', to_marker_id: 'LEG_A', requires_switch_state: 'main' },
    { from_marker_id: 'JCT', to_marker_id: 'LEG_B', requires_switch_state: 'divert' },
    { from_marker_id: 'LEG_A', to_marker_id: 'JCT' },
    { from_marker_id: 'LEG_B', to_marker_id: 'JCT' },
  ],
  junctions: [],
};

const build = (): LayoutState => new LayoutState(TURNOUT, { confirmTraversals: 3, now: () => 0 });

describe('LayoutState topology queries', () => {
  it('reports edges entering a marker and none for an unknown one', () => {
    const layout = build();
    expect(
      layout
        .edgesInto('JCT')
        .map((e) => e.from_marker_id)
        .sort(),
    ).toEqual(['LEG_A', 'LEG_B', 'TRUNK']);
    expect(layout.edgesInto('NOPE')).toEqual([]);
    expect(layout.edgesFrom('NOPE')).toEqual([]);
  });

  it('distinguishes wired-in markers from orphans and unknown ids', () => {
    const layout = build();
    expect(layout.hasIncidentEdges('TRUNK')).toBe(true);
    expect(layout.hasIncidentEdges('LEG_A')).toBe(true);
    expect(layout.hasIncidentEdges('ORPHAN')).toBe(false);
    expect(layout.hasIncidentEdges('NOPE')).toBe(false);
  });

  it('resolves the active edge from a junction by switch position', () => {
    const layout = build();
    expect(layout.activeEdgeFrom('NOPE')).toBeUndefined();
    expect(layout.activeEdgeFrom('TRUNK')?.to_marker_id).toBe('JCT');
    expect(layout.activeEdgeFrom('JCT')).toBeUndefined();
    layout.setSwitchPosition('JCT', 'divert');
    expect(layout.activeEdgeFrom('JCT')?.to_marker_id).toBe('LEG_B');
    layout.setSwitchPosition('JCT', 'main');
    expect(layout.activeEdgeFrom('JCT')?.to_marker_id).toBe('LEG_A');
  });

  it('ignores inferred edges that exist, or touch unknown markers', () => {
    const layout = build();
    layout.addInferredEdge('TRUNK', 'JCT');
    layout.addInferredEdge('TRUNK', 'NOPE');
    layout.addInferredEdge('NOPE', 'TRUNK');
    expect(layout.findEdge('TRUNK', 'JCT')?.inferred).toBeUndefined();
    expect(layout.findEdge('TRUNK', 'NOPE')).toBeUndefined();
  });

  it('promotes an inferred edge once it has been traversed enough', () => {
    const layout = build();
    layout.addInferredEdge('TRUNK', 'LEG_A');
    expect(layout.findEdge('TRUNK', 'LEG_A')?.inferred).toBe(true);
    layout.recordTraversal('TRUNK', 'LEG_A');
    layout.recordTraversal('TRUNK', 'LEG_A');
    layout.recordTraversal('TRUNK', 'LEG_A');
    expect(layout.findEdge('TRUNK', 'LEG_A')?.inferred).toBe(false);
    expect(layout.edgesInto('LEG_A').find((e) => e.from_marker_id === 'TRUNK')?.inferred).toBe(
      false,
    );
  });

  it('prunes only orphan markers, in ascending order', () => {
    const layout = build();
    layout.upsertMarker('ZED', 'block_boundary');
    layout.upsertMarker('ALPHA', 'block_boundary');
    expect(layout.upsertMarker('ALPHA', 'block_boundary')).toBe(false);
    expect(layout.pruneOrphanMarkers()).toEqual(['ALPHA', 'ORPHAN', 'ZED']);
    expect(layout.hasMarker('TRUNK')).toBe(true);
    expect(layout.pruneOrphanMarkers()).toEqual([]);
  });
});

describe('planTransit through a turnout', () => {
  it('routes trunk to a leg through the junction', () => {
    expect(planTransit(build(), 'TRUNK', 'LEG_B')).toEqual([
      { from_marker_id: 'TRUNK', to_marker_id: 'JCT' },
      { from_marker_id: 'JCT', to_marker_id: 'LEG_B' },
    ]);
  });

  it('refuses a leg-to-leg cross through the junction', () => {
    expect(planTransit(build(), 'LEG_A', 'LEG_B')).toBeNull();
  });

  it('refuses an unknown endpoint', () => {
    expect(planTransit(build(), 'NOPE', 'LEG_A')).toBeNull();
    expect(planTransit(build(), 'TRUNK', 'NOPE')).toBeNull();
  });

  it('returns null when a forced continuation leads to an unknown marker', () => {
    const layout = build();
    expect(
      planTransit(layout, 'TRUNK', 'LEG_A', { from_marker_id: 'TRUNK', to_marker_id: 'NOPE' }),
    ).toBeNull();
  });

  it('returns null when the forced continuation cannot reach the target', () => {
    expect(
      planTransit(build(), 'TRUNK', 'ORPHAN', { from_marker_id: 'TRUNK', to_marker_id: 'JCT' }),
    ).toBeNull();
  });

  it('plans a one-edge route when the forced continuation is the target', () => {
    expect(
      planTransit(build(), 'TRUNK', 'JCT', { from_marker_id: 'TRUNK', to_marker_id: 'JCT' }),
    ).toEqual([{ from_marker_id: 'TRUNK', to_marker_id: 'JCT' }]);
  });
});
