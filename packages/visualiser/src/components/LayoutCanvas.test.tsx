import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { LayoutCanvas, buildMarkerTangents, mergeEdges } from './LayoutCanvas.js';

const SIMPLE_LOOP_LAYOUT = {
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

function deliverState(client: InMemoryBrokerSubscriber, topic: string, payload: unknown): void {
  client.deliver({
    topic,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

function deliverEvent(client: InMemoryBrokerSubscriber, topic: string, payload: unknown): void {
  client.deliver({
    topic,
    payload: new TextEncoder().encode(JSON.stringify({ payload })),
  });
}

function renderCanvas(): { client: InMemoryBrokerSubscriber } {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  render(
    <BrokerProvider client={client}>
      <LayoutCanvas />
    </BrokerProvider>,
  );
  return { client };
}

describe('LayoutCanvas', () => {
  it('shows a waiting message before any layout state arrives', () => {
    renderCanvas();
    expect(screen.getByTestId('layout-empty')).toBeInTheDocument();
  });

  it('renders one marker per layout marker once the layout state arrives', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', SIMPLE_LOOP_LAYOUT));

    const markers = screen.getByTestId('markers');
    const markerNodes = markers.querySelectorAll('[data-marker-id]');
    expect(markerNodes.length).toBe(4);
    expect(markers.querySelector('[data-marker-id="M3"]')).not.toBeNull();
  });

  it('renders one edge per layout edge as a path element with a d attribute', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', SIMPLE_LOOP_LAYOUT));

    const edges = screen.getByTestId('edges');
    const paths = edges.querySelectorAll('path[d]');
    expect(paths.length).toBe(4);
    // Each path's d attribute should start with an SVG Move command.
    for (const path of Array.from(paths)) {
      expect(path.getAttribute('d')).toMatch(/^M /);
    }
  });

  it('renders inferred edges as dashed and confirmed edges as solid', () => {
    const layoutWithInferredEdge = {
      name: 'discovery-loop',
      markers: [
        { id: 'M1', kind: 'block_boundary' },
        { id: 'M2', kind: 'block_boundary' },
        { id: 'M3', kind: 'block_boundary' },
      ],
      edges: [
        { from_marker_id: 'M1', to_marker_id: 'M2' },
        { from_marker_id: 'M2', to_marker_id: 'M3', inferred: true },
      ],
      junctions: [],
    };
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/discovery-loop', layoutWithInferredEdge));

    const edges = screen.getByTestId('edges');
    const paths = edges.querySelectorAll('path[d]');
    expect(paths.length).toBe(2);

    const inferredPath = edges.querySelector('path[data-inferred="true"]');
    expect(inferredPath).not.toBeNull();
    expect(inferredPath?.getAttribute('stroke-dasharray')).toBe('8 6');

    // The confirmed edge should have no data-inferred attribute at all.
    const allPaths = Array.from(paths);
    const confirmedPath = allPaths.find((p) => !p.hasAttribute('data-inferred'));
    expect(confirmedPath).not.toBeUndefined();
    expect(confirmedPath?.hasAttribute('stroke-dasharray')).toBe(false);
  });

  it('places a train marker at its last reported marker', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', SIMPLE_LOOP_LAYOUT));

    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
      }),
    );

    const trains = screen.getByTestId('trains');
    const trainNode = trains.querySelector('[data-train-id="T1"]');
    expect(trainNode).not.toBeNull();
    expect(trainNode?.getAttribute('data-at-marker')).toBe('M2');
  });

  it('moves the train when later marker_traversed events arrive', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', SIMPLE_LOOP_LAYOUT));
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M2',
      }),
    );
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M3',
      }),
    );

    const trains = screen.getByTestId('trains');
    const trainNode = trains.querySelector('[data-train-id="T1"]');
    expect(trainNode?.getAttribute('data-at-marker')).toBe('M3');
  });

  it('renders an accessible track diagram label', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', SIMPLE_LOOP_LAYOUT));

    const region = screen.getByLabelText(/^layout$/i);
    expect(
      within(region).getByRole('img', { name: /track diagram for simple-loop/i }),
    ).toBeInTheDocument();
  });

  it('renders a train as a path inside a group with data-train-id', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', SIMPLE_LOOP_LAYOUT));
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M1',
      }),
    );

    const trains = screen.getByTestId('trains');
    const trainGroup = trains.querySelector('[data-train-id="T1"]');
    expect(trainGroup).not.toBeNull();
    // The icon should be a <path> element (not a <circle>) inside the group.
    const trainPath = trainGroup?.querySelector('path');
    expect(trainPath).not.toBeNull();
    expect(trainPath?.getAttribute('d')).toBeTruthy();
  });

  it('interpolates a train along its edge when train_status arrives with edge metadata', () => {
    const layoutWithLengths = {
      ...SIMPLE_LOOP_LAYOUT,
      edges: SIMPLE_LOOP_LAYOUT.edges.map((e) => ({ ...e, estimated_length_mm: 200 })),
    };
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', layoutWithLengths));
    act(() =>
      deliverEvent(client, 'railway/events/train_status/T1', {
        train_id: 'T1',
        current_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
        estimated_distance_from_edge_start_mm: 100, // halfway along a 200mm edge
        speed_normalised: 0.5,
      }),
    );

    const trainNode = screen.getByTestId('trains').querySelector('[data-train-id="T1"]');
    // The train should be reported as on M1->M2.
    expect(trainNode?.getAttribute('data-on-edge')).toBe('M1->M2');
    // The train icon is a <path> with a transform that includes translate.
    const trainPath = trainNode?.querySelector('path');
    expect(trainPath).not.toBeNull();
    const transform = trainPath?.getAttribute('transform') ?? '';
    expect(transform).toMatch(/translate\(/);
    expect(transform).toMatch(/rotate\(/);
  });

  it('sets data-cleared-to on an edge path when the clearance map holds it', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', SIMPLE_LOOP_LAYOUT));

    // Deliver a retained clearance state: T1 holds M1→M2.
    act(() =>
      deliverState(client, 'railway/state/clearance/T1', {
        train_id: 'T1',
        cleared_edges: [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
      }),
    );

    const edges = screen.getByTestId('edges');
    const clearedPath = edges.querySelector('path[data-cleared-to="T1"]');
    expect(clearedPath).not.toBeNull();

    // The other edges should have an empty data-cleared-to attribute.
    const allPaths = Array.from(edges.querySelectorAll('path[d]'));
    const unclearedPaths = allPaths.filter((p) => p.getAttribute('data-cleared-to') !== 'T1');
    expect(unclearedPaths.length).toBe(3);
    for (const path of unclearedPaths) {
      expect(path.getAttribute('data-cleared-to')).toBe('');
    }
  });

  it('prefers the latest train_status over a stale marker_traversed', () => {
    const layoutWithLengths = {
      ...SIMPLE_LOOP_LAYOUT,
      edges: SIMPLE_LOOP_LAYOUT.edges.map((e) => ({ ...e, estimated_length_mm: 200 })),
    };
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', layoutWithLengths));
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M1',
      }),
    );
    act(() =>
      deliverEvent(client, 'railway/events/train_status/T1', {
        train_id: 'T1',
        current_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
        estimated_distance_from_edge_start_mm: 50,
        speed_normalised: 0.25,
      }),
    );
    const trainNode = screen.getByTestId('trains').querySelector('[data-train-id="T1"]');
    expect(trainNode?.getAttribute('data-on-edge')).toBe('M1->M2');
    expect(trainNode?.getAttribute('data-at-marker')).toBeNull();
  });
});

describe('buildMarkerTangents — neighbour-position tangents', () => {
  // Magnitude of the 2D cross product of two unit-ish vectors. ~0 ⇒ parallel
  // (collinear). The tangent SIGN is unconstrained by the contract (the bezier
  // builder re-orients per edge), so assert parallelism, not an exact sign.
  const cross = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.abs(a.x * b.y - a.y * b.x);

  /**
   * Three markers in a horizontal straight line: A(0,0) B(100,0) C(200,0).
   * Edges: A→B and B→C.
   *
   * Under the Catmull-Rom rule, the degree-2 tangent at B is the chord through
   * its two neighbours, unit(C − A) = (1,0). The degree-1 termini A and C take
   * unit(marker − neighbour): tA = unit(A − B) = (−1,0), tC = unit(C − B) =
   * (1,0). All three are PARALLEL to the line (the rendered curve is
   * sign-invariant), and a unit length.
   */
  it('gives a chord-through tangent at a degree-2 marker and along-line termini', () => {
    const markers = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    const edges = [
      { from_marker_id: 'A', to_marker_id: 'B' },
      { from_marker_id: 'B', to_marker_id: 'C' },
    ];
    const markerPositions = new Map([
      ['A', { x: 0, y: 0 }],
      ['B', { x: 100, y: 0 }],
      ['C', { x: 200, y: 0 }],
    ]);

    const tangents = buildMarkerTangents(markers, edges, markerPositions);

    const horizontal = { x: 1, y: 0 };
    for (const id of ['A', 'B', 'C']) {
      const t = tangents.get(id);
      expect(t).toBeDefined();
      if (!t) continue;
      // Parallel to the line…
      expect(cross(t, horizontal)).toBeCloseTo(0, 5);
      expect(t.y).toBeCloseTo(0, 5);
      // …and a unit vector.
      expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 5);
    }
  });

  /**
   * A degree-2 marker's tangent is exactly the unit chord of its two
   * neighbours, regardless of the (non-straight) angle between the legs.
   * Neighbours P(0,0) and Q(0,200) of B(100,0): chord = unit(Q − P) = (0,1).
   */
  it('sets a degree-2 tangent to the unit chord of its two neighbours', () => {
    const markers = [{ id: 'P' }, { id: 'B' }, { id: 'Q' }];
    const edges = [
      { from_marker_id: 'P', to_marker_id: 'B' },
      { from_marker_id: 'B', to_marker_id: 'Q' },
    ];
    const markerPositions = new Map([
      ['P', { x: 0, y: 0 }],
      ['B', { x: 100, y: 0 }],
      ['Q', { x: 0, y: 200 }],
    ]);

    const tB = buildMarkerTangents(markers, edges, markerPositions).get('B');
    expect(tB).toBeDefined();
    // unit(Q − P) = (0, 1), up to sign.
    expect(cross(tB ?? { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(0, 5);
    expect(tB?.x ?? 1).toBeCloseTo(0, 5);
    expect(Math.hypot(tB?.x ?? 0, tB?.y ?? 0)).toBeCloseTo(1, 5);
  });

  /**
   * A junction (degree ≥ 3) picks the STRAIGHTEST neighbour pair. J at the
   * origin with collinear neighbours A(−100,0), B(100,0) and a perpendicular
   * branch C(0,100). The main line A–B is straightest, so the tangent is the
   * A–B chord (horizontal) and the perpendicular branch is ignored.
   */
  it('picks the most-collinear neighbour pair at a junction (degree ≥ 3)', () => {
    const markers = [{ id: 'J' }, { id: 'A' }, { id: 'B' }, { id: 'C' }];
    const edges = [
      { from_marker_id: 'A', to_marker_id: 'J' },
      { from_marker_id: 'J', to_marker_id: 'B' },
      { from_marker_id: 'J', to_marker_id: 'C' },
    ];
    const markerPositions = new Map([
      ['J', { x: 0, y: 0 }],
      ['A', { x: -100, y: 0 }],
      ['B', { x: 100, y: 0 }],
      ['C', { x: 0, y: 100 }],
    ]);

    const tJ = buildMarkerTangents(markers, edges, markerPositions).get('J');
    expect(tJ).toBeDefined();
    // The straight A–B line wins: tangent is horizontal, NOT the C branch.
    expect(cross(tJ ?? { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 5);
    expect(tJ?.y ?? 1).toBeCloseTo(0, 5);
    expect(Math.hypot(tJ?.x ?? 0, tJ?.y ?? 0)).toBeCloseTo(1, 5);
  });

  /**
   * An isolated marker (degree 0 — no incident edges) gets the sane {1, 0}
   * fallback rather than NaN.
   */
  it('falls back to (1, 0) for an isolated (degree-0) marker', () => {
    const markers = [{ id: 'LONE' }];
    const markerPositions = new Map([['LONE', { x: 5, y: 5 }]]);

    const t = buildMarkerTangents(markers, [], markerPositions).get('LONE');
    expect(t).toEqual({ x: 1, y: 0 });
  });

  it('renders a straight three-marker chain with collinear control points at the shared marker', () => {
    // Layout: A, B, C in a horizontal line (same y_mm).
    // All markers share y_mm=50; x_mm increases left to right.
    const straightLineLayout = {
      name: 'straight-line',
      markers: [
        { id: 'A', kind: 'block_boundary', position: { x_mm: 0, y_mm: 50 } },
        { id: 'B', kind: 'block_boundary', position: { x_mm: 100, y_mm: 50 } },
        { id: 'C', kind: 'block_boundary', position: { x_mm: 200, y_mm: 50 } },
      ],
      edges: [
        { from_marker_id: 'A', to_marker_id: 'B' },
        { from_marker_id: 'B', to_marker_id: 'C' },
      ],
      junctions: [],
    };

    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/straight-line', straightLineLayout));

    const edgesGroup = screen.getByTestId('edges');
    const paths = Array.from(edgesGroup.querySelectorAll('path[d]'));
    expect(paths.length).toBe(2);

    // Extract the start-y (sy) and both control-point y values from a path `d`.
    // d format: "M sx sy C cx1 cy1, cx2 cy2, ex ey"
    const parsePathYs = (d: string): { startY: number; cy1: number; cy2: number } | undefined => {
      const match =
        /M [0-9.e+-]+ ([0-9.e+-]+) C [0-9.e+-]+ ([0-9.e+-]+),\s*[0-9.e+-]+ ([0-9.e+-]+),/.exec(d);
      if (!match) return undefined;
      return { startY: Number(match[1]), cy1: Number(match[2]), cy2: Number(match[3]) };
    };

    // Both paths should exist and have d attributes.
    const dA = paths[0]?.getAttribute('d') ?? '';
    const dB = paths[1]?.getAttribute('d') ?? '';
    expect(dA).toMatch(/^M /);
    expect(dB).toMatch(/^M /);

    // For a straight horizontal chain, all control-point y values must equal
    // the marker y (the start-y of their respective path), since the tangent
    // at every marker points horizontally and handles lie on the same y-axis.
    for (const d of [dA, dB]) {
      const ys = parsePathYs(d);
      expect(ys).toBeDefined();
      if (!ys) continue;
      const { startY, cy1, cy2 } = ys;
      expect(cy1).toBeCloseTo(startY, 2);
      expect(cy2).toBeCloseTo(startY, 2);
    }
  });
});

describe('mergeEdges — undirected pair collapsing', () => {
  it('collapses a both-directions pair into one two-way merged edge', () => {
    const merged = mergeEdges([
      { from_marker_id: 'A', to_marker_id: 'B' },
      { from_marker_id: 'B', to_marker_id: 'A' },
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]?.oneWay).toBe(false);
    expect(merged[0]?.pairKey).toBe('A|B');
  });

  it('keeps a single-direction pair as a one-way merged edge in the permitted direction', () => {
    const merged = mergeEdges([{ from_marker_id: 'B', to_marker_id: 'A' }]);
    expect(merged.length).toBe(1);
    expect(merged[0]?.oneWay).toBe(true);
    // Forward preserves the permitted direction (B→A), not the sorted pair order.
    expect(merged[0]?.forward.from_marker_id).toBe('B');
    expect(merged[0]?.forward.to_marker_id).toBe('A');
  });

  it('marks a merged edge inferred when either direction is inferred', () => {
    const merged = mergeEdges([
      { from_marker_id: 'A', to_marker_id: 'B' },
      { from_marker_id: 'B', to_marker_id: 'A', inferred: true },
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]?.inferred).toBe(true);
  });
});

const TWO_WAY_LAYOUT = {
  name: 'two-way-pair',
  markers: [
    { id: 'M1', kind: 'block_boundary', position: { x_mm: 0, y_mm: 0 } },
    { id: 'M2', kind: 'block_boundary', position: { x_mm: 100, y_mm: 0 } },
    { id: 'M3', kind: 'block_boundary', position: { x_mm: 100, y_mm: 100 } },
  ],
  edges: [
    // M1↔M2 is bidirectional (two-way); M2→M3 is one-way only.
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M1', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
  ],
  junctions: [],
};

describe('LayoutCanvas — merged edge rendering', () => {
  it('renders ONE rail path per undirected marker pair (not one per direction)', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));

    const edges = screen.getByTestId('edges');
    // Two undirected pairs (M1|M2, M2|M3) despite three directed edges.
    const pairs = edges.querySelectorAll('[data-edge-pair]');
    expect(pairs.length).toBe(2);
    // Exactly one rail <path> per pair.
    const rails = edges.querySelectorAll('path[d]');
    expect(rails.length).toBe(2);
  });

  it('marks the two-way pair as two-way and the single-direction pair as one-way', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));

    const edges = screen.getByTestId('edges');
    const twoWay = edges.querySelector('[data-edge-pair="M1|M2"]');
    const oneWay = edges.querySelector('[data-edge-pair="M2|M3"]');
    expect(twoWay?.getAttribute('data-direction')).toBe('two-way');
    expect(oneWay?.getAttribute('data-direction')).toBe('one-way');
  });

  it('draws an arrowhead glyph on the one-way pair but not the uncleared two-way pair', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));

    const edges = screen.getByTestId('edges');
    const twoWay = edges.querySelector('[data-edge-pair="M1|M2"]');
    const oneWay = edges.querySelector('[data-edge-pair="M2|M3"]');
    expect(oneWay?.querySelector('polygon[data-edge-arrow="true"]')).not.toBeNull();
    expect(twoWay?.querySelector('polygon[data-edge-arrow="true"]')).toBeNull();
  });

  it('highlights a merged two-way edge in the holding train colour, even when only the reverse direction is cleared', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));

    // T1 holds M2→M1, which is the REVERSE of the merged pair's forward (M1→M2).
    act(() =>
      deliverState(client, 'railway/state/clearance/T1', {
        train_id: 'T1',
        cleared_edges: [{ from_marker_id: 'M2', to_marker_id: 'M1' }],
      }),
    );

    const svg = screen.getByTestId('layout-canvas');
    const edges = screen.getByTestId('edges');
    const pair = edges.querySelector('[data-edge-pair="M1|M2"]');
    const railPath = pair?.querySelector('path[data-cleared-to="T1"]');
    expect(railPath).not.toBeNull();
    // A cleared edge gets the thicker rail (9px on screen) and an arrowhead
    // (direction of hold). Stroke widths are now scaled by f = size / 600 so
    // they render at a constant *screen* size; derive the expected world width.
    const f = Number(svg.getAttribute('data-viewport-size')) / 600;
    expect(Number(railPath?.getAttribute('stroke-width'))).toBeCloseTo(9 * f, 5);
    expect(pair?.querySelector('polygon[data-edge-arrow="true"]')).not.toBeNull();
  });

  it('still places a train on the single merged rail when its current_edge is the reverse direction', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));
    // Train running M2→M1 — the reverse of the merged pair's forward sense.
    act(() =>
      deliverEvent(client, 'railway/events/train_status/T9', {
        train_id: 'T9',
        current_edge: { from_marker_id: 'M2', to_marker_id: 'M1' },
        estimated_distance_from_edge_start_mm: 100,
        speed_normalised: 0.5,
      }),
    );
    const trainNode = screen.getByTestId('trains').querySelector('[data-train-id="T9"]');
    expect(trainNode?.getAttribute('data-on-edge')).toBe('M2->M1');
    const transform = trainNode?.querySelector('path')?.getAttribute('transform') ?? '';
    expect(transform).toMatch(/translate\(/);
  });
});

/**
 * Mock getBoundingClientRect so client→world conversion has a non-zero rect in
 * jsdom (which otherwise reports 0×0). Returns a restore fn.
 */
function mockSvgRect(): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 600,
    bottom: 600,
    width: 600,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return () => spy.mockRestore();
}

describe('LayoutCanvas — fit-to-content + pan/zoom', () => {
  it('fits the viewBox to the graph bounding box (not the fixed 600×600 box)', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));

    const svg = screen.getByTestId('layout-canvas');
    const viewBox = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    // The spatial layout spans 100×100 mm; the fitted square window is that plus
    // margin — well under the legacy 600 box and not the legacy "0 0 600 600".
    expect(viewBox[2]).toBeGreaterThan(0);
    expect(viewBox[2]).toBeLessThan(600);
    expect(viewBox[2]).toBe(viewBox[3]); // square window
  });

  it('zooms in on wheel-up: the viewBox window shrinks', () => {
    const restore = mockSvgRect();
    try {
      const { client } = renderCanvas();
      act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));

      const svg = screen.getByTestId('layout-canvas');
      const before = Number(svg.getAttribute('data-viewport-size'));
      fireEvent.wheel(svg, { deltaY: -100, clientX: 300, clientY: 300 });
      const after = Number(svg.getAttribute('data-viewport-size'));
      expect(after).toBeLessThan(before);
    } finally {
      restore();
    }
  });

  it('zooms out on wheel-down: the viewBox window grows', () => {
    const restore = mockSvgRect();
    try {
      const { client } = renderCanvas();
      act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));

      const svg = screen.getByTestId('layout-canvas');
      const before = Number(svg.getAttribute('data-viewport-size'));
      fireEvent.wheel(svg, { deltaY: 120, clientX: 300, clientY: 300 });
      const after = Number(svg.getAttribute('data-viewport-size'));
      expect(after).toBeGreaterThan(before);
    } finally {
      restore();
    }
  });

  it('pans the viewBox origin on pointer drag', () => {
    const restore = mockSvgRect();
    try {
      const { client } = renderCanvas();
      act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));

      const svg = screen.getByTestId('layout-canvas');
      const beforeX = Number(svg.getAttribute('data-viewport-x'));
      act(() => {
        svg.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 300 }),
        );
        svg.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 360, clientY: 300 }),
        );
        svg.dispatchEvent(
          new MouseEvent('pointerup', { bubbles: true, clientX: 360, clientY: 300 }),
        );
      });
      const afterX = Number(svg.getAttribute('data-viewport-x'));
      // Dragging right moves the content right, so the world origin moves left.
      expect(afterX).toBeLessThan(beforeX);
    } finally {
      restore();
    }
  });

  it('re-fits the view when a new layout (different topology) arrives, discarding zoom', () => {
    const restore = mockSvgRect();
    try {
      const { client } = renderCanvas();
      act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));
      const svg = screen.getByTestId('layout-canvas');
      const fitSize = Number(svg.getAttribute('data-viewport-size'));

      // Perturb the view by zooming in — proves the next assertion isn't vacuous.
      fireEvent.wheel(svg, { deltaY: -100, clientX: 300, clientY: 300 });
      expect(Number(svg.getAttribute('data-viewport-size'))).toBeLessThan(fitSize);

      // A new layout (different name + marker count) re-fits, discarding the zoom.
      const otherLayout = {
        name: 'other',
        markers: [
          { id: 'A', kind: 'block_boundary', position: { x_mm: 0, y_mm: 0 } },
          { id: 'B', kind: 'block_boundary', position: { x_mm: 100, y_mm: 0 } },
        ],
        edges: [{ from_marker_id: 'A', to_marker_id: 'B' }],
        junctions: [],
      };
      act(() => deliverState(client, 'railway/state/layout/other', otherLayout));
      // Both layouts normalise into the same scaled box, so the re-fit size is
      // back to the fit size — the zoom was discarded.
      expect(Number(svg.getAttribute('data-viewport-size'))).toBe(fitSize);
    } finally {
      restore();
    }
  });

  it('zooms with a degenerate (zero-size) rect by anchoring on the centre', () => {
    // No rect mock: jsdom reports a 0×0 rect, exercising the zero-size
    // fallback branches in zoomViewport (frac defaults to 0.5).
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));
    const svg = screen.getByTestId('layout-canvas');
    const before = Number(svg.getAttribute('data-viewport-size'));
    fireEvent.wheel(svg, { deltaY: -100, clientX: 0, clientY: 0 });
    expect(Number(svg.getAttribute('data-viewport-size'))).toBeLessThan(before);
  });

  it('pans with a degenerate (zero-size) rect without moving the origin', () => {
    // No rect mock → 0×0 rect → panViewport's zero-size branch (no movement).
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));
    const svg = screen.getByTestId('layout-canvas');
    const beforeX = Number(svg.getAttribute('data-viewport-x'));
    act(() => {
      svg.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
      svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 80 }));
      svg.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 80, clientY: 80 }));
    });
    expect(Number(svg.getAttribute('data-viewport-x'))).toBe(beforeX);
  });
});

describe('LayoutCanvas — zoom spreads markers at constant screen size', () => {
  // Read a marker's world radius and its world position from the rendered SVG.
  const markerOf = (id: string): { r: number; cx: number; cy: number } => {
    const circle = screen.getByTestId('markers').querySelector(`[data-marker-id="${id}"] circle`);
    if (circle === null) throw new Error(`marker ${id} not rendered`);
    return {
      r: Number(circle.getAttribute('r')),
      cx: Number(circle.getAttribute('cx')),
      cy: Number(circle.getAttribute('cy')),
    };
  };
  // Screen px = world value × (VIEWBOX / viewport.size).
  const toScreen = (worldValue: number, viewportSize: number): number =>
    (worldValue * 600) / viewportSize;
  const worldSeparation = (a: { cx: number; cy: number }, b: { cx: number; cy: number }): number =>
    Math.hypot(a.cx - b.cx, a.cy - b.cy);

  it('holds marker SCREEN size constant while world size shrinks, and grows inter-marker SCREEN distance, on zoom-in', () => {
    const restore = mockSvgRect();
    try {
      const { client } = renderCanvas();
      act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));
      const svg = screen.getByTestId('layout-canvas');

      const sizeBefore = Number(svg.getAttribute('data-viewport-size'));
      const m1Before = markerOf('M1');
      const m2Before = markerOf('M2');
      const screenRadiusBefore = toScreen(m1Before.r, sizeBefore);
      const screenSepBefore = toScreen(worldSeparation(m1Before, m2Before), sizeBefore);

      // Zoom in: the viewBox window shrinks.
      fireEvent.wheel(svg, { deltaY: -100, clientX: 300, clientY: 300 });

      const sizeAfter = Number(svg.getAttribute('data-viewport-size'));
      expect(sizeAfter).toBeLessThan(sizeBefore);

      const m1After = markerOf('M1');
      const m2After = markerOf('M2');

      // World radius SHRINKS on zoom-in (sizes scale with f = size / 600)…
      expect(m1After.r).toBeLessThan(m1Before.r);
      // …but the SCREEN radius is unchanged: nodes stay the same on screen.
      const screenRadiusAfter = toScreen(m1After.r, sizeAfter);
      expect(screenRadiusAfter).toBeCloseTo(screenRadiusBefore, 5);

      // World positions are NOT scaled, so on screen the markers spread apart:
      // their SCREEN separation grows even though their screen size held.
      const screenSepAfter = toScreen(worldSeparation(m1After, m2After), sizeAfter);
      expect(screenSepAfter).toBeGreaterThan(screenSepBefore);
    } finally {
      restore();
    }
  });

  it('scales every glyph at the fit default to the documented constant screen sizes (≈14px marker, 12px label, 6px rail)', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/two-way-pair', TWO_WAY_LAYOUT));
    const svg = screen.getByTestId('layout-canvas');
    const size = Number(svg.getAttribute('data-viewport-size'));

    const circle = screen.getByTestId('markers').querySelector('[data-marker-id="M1"] circle');
    const label = screen.getByTestId('markers').querySelector('[data-marker-id="M1"] text');
    // The uncleared two-way rail is the 6px-screen stroke.
    const rail = screen
      .getByTestId('edges')
      .querySelector('[data-edge-pair="M1|M2"] path[data-cleared-to=""]');

    expect(toScreen(Number(circle?.getAttribute('r')), size)).toBeCloseTo(14, 5);
    expect(toScreen(Number(label?.getAttribute('font-size')), size)).toBeCloseTo(12, 5);
    expect(toScreen(Number(rail?.getAttribute('stroke-width')), size)).toBeCloseTo(6, 5);
  });
});

/*
 * Spatial layout used by the length-aware rendering tests.  All markers have
 * x_mm / y_mm positions so `scaleSpatialPositions` fires and mmToSvgScale is
 * non-null, enabling the swept-body path.
 *
 * Layout: M1→M2→M3→M4→M1, a simple directed loop.
 * Each edge is 200 mm; spatial coords spread the markers widely enough that
 * the scale factor is well-defined.
 */
const SPATIAL_LOOP_LAYOUT = {
  name: 'spatial-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary', position: { x_mm: 0, y_mm: 0 } },
    { id: 'M2', kind: 'block_boundary', position: { x_mm: 200, y_mm: 0 } },
    { id: 'M3', kind: 'block_boundary', position: { x_mm: 200, y_mm: 200 } },
    { id: 'M4', kind: 'block_boundary', position: { x_mm: 0, y_mm: 200 } },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

describe('LayoutCanvas — length-aware (ADR-016) rendering', () => {
  it('parses train_length_mm from the device retained state into the registered-devices hook', async () => {
    /* This is a state-level test: deliver a device payload with train_length_mm
     * and verify the group carries the data attribute that the render function
     * sets only when the field is present and positive. */
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/spatial-loop', SPATIAL_LOOP_LAYOUT));

    /* Device retained state: T1 has train_length_mm = 120. */
    act(() =>
      deliverState(client, 'railway/state/devices/T1', {
        capabilities: ['core.controls_motion'],
        train_length_mm: 120,
      }),
    );
    /* Place the train mid-edge so the swept body can render. */
    act(() =>
      deliverEvent(client, 'railway/events/train_status/T1', {
        train_id: 'T1',
        current_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
        estimated_distance_from_edge_start_mm: 150,
        speed_normalised: 0.5,
      }),
    );

    const trainGroup = screen.getByTestId('trains').querySelector('[data-train-id="T1"]');
    /* The data-train-length-mm attribute is set only when the device payload
     * was parsed and a positive length surfaced to the renderer. */
    expect(trainGroup?.getAttribute('data-train-length-mm')).toBe('120');
  });

  it('renders a swept body path and no data-tail-on-edge when tail stays on current edge', () => {
    /* Train length 120 mm, on a 200 mm edge, 150 mm into it.
     * Tail is at 150-120 = 30 mm into M1→M2 — still on the same edge. */
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/spatial-loop', SPATIAL_LOOP_LAYOUT));
    act(() =>
      deliverState(client, 'railway/state/devices/T1', {
        capabilities: ['core.controls_motion'],
        train_length_mm: 120,
      }),
    );
    act(() =>
      deliverEvent(client, 'railway/events/train_status/T1', {
        train_id: 'T1',
        current_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
        estimated_distance_from_edge_start_mm: 150,
        speed_normalised: 0.5,
      }),
    );

    const trainGroup = screen.getByTestId('trains').querySelector('[data-train-id="T1"]');
    /* Swept body: a <path> with fill="none" is the body stroke. */
    const bodyPath = trainGroup?.querySelector('path[fill="none"]');
    expect(bodyPath).not.toBeNull();
    expect(bodyPath?.getAttribute('d')).toMatch(/^M /);
    /* Pointed nose: a filled <path> (not fill="none") inside the same group. */
    const nosePath = trainGroup?.querySelector('path:not([fill="none"])');
    expect(nosePath).not.toBeNull();
    expect(nosePath?.getAttribute('d')).toBeTruthy();
    /* Label: a <text> element showing the train ID. */
    const label = trainGroup?.querySelector('text');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('T1');
    /* Tail has not crossed into the previous edge. */
    expect(trainGroup?.hasAttribute('data-tail-on-edge')).toBe(false);
  });

  it('sets data-tail-on-edge when the body spills onto the previous edge', () => {
    /* Train length 120 mm, on a 200 mm edge, only 60 mm in.
     * Tail is at 60-120 = -60 mm → spills 60 mm onto the previous edge M4→M1.
     * History is seeded by a marker_traversed event with inferred_edge M4→M1. */
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/spatial-loop', SPATIAL_LOOP_LAYOUT));
    act(() =>
      deliverState(client, 'railway/state/devices/T1', {
        capabilities: ['core.controls_motion'],
        train_length_mm: 120,
      }),
    );
    /* Seed history: crossing M1 with inferred_edge = M4→M1 records that the
     * train completed that edge just before arriving on M1→M2. */
    act(() =>
      deliverEvent(client, 'railway/events/marker_traversed/T1', {
        train_id: 'T1',
        marker_id: 'M1',
        inferred_edge: { from_marker_id: 'M4', to_marker_id: 'M1' },
      }),
    );
    act(() =>
      deliverEvent(client, 'railway/events/train_status/T1', {
        train_id: 'T1',
        current_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
        estimated_distance_from_edge_start_mm: 60,
        speed_normalised: 0.3,
      }),
    );

    const trainGroup = screen.getByTestId('trains').querySelector('[data-train-id="T1"]');
    expect(trainGroup?.getAttribute('data-tail-on-edge')).toBe('M4->M1');
    /* Body path still present. */
    const bodyPath = trainGroup?.querySelector('path[fill="none"]');
    expect(bodyPath).not.toBeNull();
  });

  it('clamps the body to the current edge when history is missing — no crash, no data-tail-on-edge', () => {
    /* Same geometry as above but no marker_traversed seeding history. */
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/spatial-loop', SPATIAL_LOOP_LAYOUT));
    act(() =>
      deliverState(client, 'railway/state/devices/T1', {
        capabilities: ['core.controls_motion'],
        train_length_mm: 120,
      }),
    );
    act(() =>
      deliverEvent(client, 'railway/events/train_status/T1', {
        train_id: 'T1',
        current_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
        estimated_distance_from_edge_start_mm: 60,
        speed_normalised: 0.3,
      }),
    );

    const trainGroup = screen.getByTestId('trains').querySelector('[data-train-id="T1"]');
    /* Body is clamped — no tail attribute. */
    expect(trainGroup?.hasAttribute('data-tail-on-edge')).toBe(false);
    /* A swept body path is still rendered (clamped to edge start). */
    const bodyPath = trainGroup?.querySelector('path[fill="none"]');
    expect(bodyPath).not.toBeNull();
  });

  it('renders the unchanged fixed icon for a point train (regression — no train_length_mm)', () => {
    /* A train with no device-state entry should fall back to the classic icon. */
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/spatial-loop', SPATIAL_LOOP_LAYOUT));
    act(() =>
      deliverEvent(client, 'railway/events/train_status/T_POINT', {
        train_id: 'T_POINT',
        current_edge: { from_marker_id: 'M1', to_marker_id: 'M2' },
        estimated_distance_from_edge_start_mm: 100,
        speed_normalised: 0.5,
      }),
    );

    const trainGroup = screen.getByTestId('trains').querySelector('[data-train-id="T_POINT"]');
    expect(trainGroup).not.toBeNull();
    /* Fixed icon: a path with a filled shape (no fill="none" body stroke). */
    const filledPath = trainGroup?.querySelector('path:not([fill="none"])');
    expect(filledPath).not.toBeNull();
    expect(filledPath?.getAttribute('d')).toBeTruthy();
    /* Classic attribute set: data-on-edge, no data-train-length-mm. */
    expect(trainGroup?.getAttribute('data-on-edge')).toBe('M1->M2');
    expect(trainGroup?.hasAttribute('data-train-length-mm')).toBe(false);
    /* No swept body path. */
    expect(trainGroup?.querySelector('path[fill="none"]')).toBeNull();
  });
});
