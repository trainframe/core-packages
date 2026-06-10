import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { nearestStartEdge } from './nearest-edge.js';

const SQUARE_LOOP: Layout = {
  name: 'square',
  markers: [
    { id: 'M-straight-1', kind: 'block_boundary', position: { x_mm: 0, y_mm: 0 } },
    { id: 'M-straight-2', kind: 'block_boundary', position: { x_mm: 200, y_mm: 0 } },
    { id: 'M-straight-3', kind: 'block_boundary', position: { x_mm: 200, y_mm: 200 } },
    { id: 'M-straight-4', kind: 'block_boundary', position: { x_mm: 0, y_mm: 200 } },
  ],
  edges: [
    { from_marker_id: 'M-straight-1', to_marker_id: 'M-straight-2', estimated_length_mm: 200 },
    { from_marker_id: 'M-straight-2', to_marker_id: 'M-straight-3', estimated_length_mm: 200 },
    { from_marker_id: 'M-straight-3', to_marker_id: 'M-straight-4', estimated_length_mm: 200 },
    { from_marker_id: 'M-straight-4', to_marker_id: 'M-straight-1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

describe('nearestStartEdge', () => {
  it('picks the edge originating at the marker closest to the drop point', () => {
    const edge = nearestStartEdge(SQUARE_LOOP, { x: 10, y: 5 });
    expect(edge).toEqual({ from_marker_id: 'M-straight-1', to_marker_id: 'M-straight-2' });
  });

  it('returns the edge from a different marker when the operator drops elsewhere', () => {
    const edge = nearestStartEdge(SQUARE_LOOP, { x: 210, y: 195 });
    expect(edge).toEqual({ from_marker_id: 'M-straight-3', to_marker_id: 'M-straight-4' });
  });

  it('sorts candidate edges deterministically by to_marker_id', () => {
    // The junction has two outgoing edges; the smaller to_marker_id wins.
    const layout: Layout = {
      name: 'fan',
      markers: [
        { id: 'M-junction-1', kind: 'junction', position: { x_mm: 0, y_mm: 0 } },
        { id: 'M-straight-9', kind: 'block_boundary', position: { x_mm: 100, y_mm: 0 } },
        { id: 'M-straight-2', kind: 'block_boundary', position: { x_mm: 0, y_mm: 100 } },
      ],
      edges: [
        { from_marker_id: 'M-junction-1', to_marker_id: 'M-straight-9', estimated_length_mm: 100 },
        { from_marker_id: 'M-junction-1', to_marker_id: 'M-straight-2', estimated_length_mm: 100 },
      ],
      junctions: [{ marker_id: 'M-junction-1', valid_positions: ['main', 'divert'] }],
    };
    const edge = nearestStartEdge(layout, { x: 1, y: 1 });
    expect(edge?.to_marker_id).toBe('M-straight-2');
  });

  it('returns undefined when no edge originates at the nearest marker', () => {
    const layout: Layout = {
      name: 'dead-end',
      markers: [
        { id: 'M-terminus-1', kind: 'terminus', position: { x_mm: 0, y_mm: 0 } },
        { id: 'M-straight-1', kind: 'block_boundary', position: { x_mm: 200, y_mm: 0 } },
      ],
      edges: [
        { from_marker_id: 'M-straight-1', to_marker_id: 'M-terminus-1', estimated_length_mm: 60 },
      ],
      junctions: [],
    };
    const edge = nearestStartEdge(layout, { x: 0, y: 0 });
    expect(edge).toBeUndefined();
  });

  it('ignores markers without a position', () => {
    const layout: Layout = {
      name: 'unpositioned',
      markers: [
        { id: 'M-straight-1', kind: 'block_boundary' },
        { id: 'M-straight-2', kind: 'block_boundary', position: { x_mm: 500, y_mm: 500 } },
      ],
      edges: [
        { from_marker_id: 'M-straight-1', to_marker_id: 'M-straight-2', estimated_length_mm: 100 },
        { from_marker_id: 'M-straight-2', to_marker_id: 'M-straight-1', estimated_length_mm: 100 },
      ],
      junctions: [],
    };
    const edge = nearestStartEdge(layout, { x: 0, y: 0 });
    // The only positioned marker is M-straight-2; it's "nearest" even though it's far.
    expect(edge?.from_marker_id).toBe('M-straight-2');
  });

  it('returns undefined when no marker has a position', () => {
    const layout: Layout = {
      name: 'no-positions',
      markers: [{ id: 'M-straight-1', kind: 'block_boundary' }],
      edges: [],
      junctions: [],
    };
    expect(nearestStartEdge(layout, { x: 0, y: 0 })).toBeUndefined();
  });

  describe('facing-aware selection', () => {
    // A mid-loop marker M with two outgoing edges: one EAST (to A-east) and one
    // WEST (to Z-west). Alphabetical sort would always pick A-east; the train's
    // facing must override that so it departs the way it points.
    const junctionOfTwo: Layout = {
      name: 'two-way',
      markers: [
        { id: 'M', kind: 'block_boundary', position: { x_mm: 0, y_mm: 0 } },
        { id: 'A-east', kind: 'block_boundary', position: { x_mm: 100, y_mm: 0 } },
        { id: 'Z-west', kind: 'block_boundary', position: { x_mm: -100, y_mm: 0 } },
      ],
      edges: [
        { from_marker_id: 'M', to_marker_id: 'A-east', estimated_length_mm: 100 },
        { from_marker_id: 'M', to_marker_id: 'Z-west', estimated_length_mm: 100 },
      ],
      junctions: [],
    };

    it('departs along the edge the train faces (east)', () => {
      const edge = nearestStartEdge(junctionOfTwo, { x: 1, y: 1 }, { x: 1, y: 0 });
      expect(edge?.to_marker_id).toBe('A-east');
    });

    it('departs along the edge the train faces (west), overriding the alpha sort', () => {
      // Facing west: must pick Z-west even though A-east sorts first.
      const edge = nearestStartEdge(junctionOfTwo, { x: 1, y: 1 }, { x: -1, y: 0 });
      expect(edge?.to_marker_id).toBe('Z-west');
    });

    it('falls back to the deterministic sort when no facing is given', () => {
      const edge = nearestStartEdge(junctionOfTwo, { x: 1, y: 1 });
      expect(edge?.to_marker_id).toBe('A-east');
    });

    it('tolerates a y-down (SVG) facing — a south-facing train at a vertical fork', () => {
      const vertical: Layout = {
        name: 'vertical-fork',
        markers: [
          { id: 'M', kind: 'block_boundary', position: { x_mm: 0, y_mm: 0 } },
          { id: 'M-north', kind: 'block_boundary', position: { x_mm: 0, y_mm: -100 } },
          { id: 'M-south', kind: 'block_boundary', position: { x_mm: 0, y_mm: 100 } },
        ],
        edges: [
          { from_marker_id: 'M', to_marker_id: 'M-north', estimated_length_mm: 100 },
          { from_marker_id: 'M', to_marker_id: 'M-south', estimated_length_mm: 100 },
        ],
        junctions: [],
      };
      // +y is DOWN (south) in table space; a south-facing loco departs south.
      expect(nearestStartEdge(vertical, { x: 0, y: 0 }, { x: 0, y: 1 })?.to_marker_id).toBe(
        'M-south',
      );
    });
  });
});
