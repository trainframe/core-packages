import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { LayoutCanvas, buildMarkerTangents } from './LayoutCanvas.js';

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

describe('buildMarkerTangents — tangent continuity', () => {
  /**
   * Three markers in a horizontal straight line: A(0,0) B(100,0) C(200,0).
   * Edges: A→B and B→C.
   *
   * The tangent at B should be (1,0) (pointing right, along the line).
   * This means:
   *   - The C2 handle of edge A→B lies at B - k*(1,0) → y=0
   *   - The C1 handle of edge B→C lies at B + k*(1,0) → y=0
   *
   * Both handles are collinear with the A–C line, which proves C1 continuity.
   *
   * We verify by rendering the layout and checking that both edge path `d`
   * strings have their control point y-values equal (within floating-point
   * tolerance) to the y-coordinate of B, i.e. all on y=0.
   */
  it('gives C1-continuous bezier handles at a straight-through marker', () => {
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

    // Tangent at B must be (1,0) — or very close — so that both adjacent
    // edges share the same horizontal direction at B.
    const tB = tangents.get('B');
    expect(tB).toBeDefined();
    expect(tB?.x ?? 0).toBeCloseTo(1, 5);
    expect(tB?.y ?? 1).toBeCloseTo(0, 5);

    // Tangent at A and C should also point right (single outgoing/incoming edge each).
    const tA = tangents.get('A');
    expect(tA?.x ?? 0).toBeCloseTo(1, 5);
    expect(tA?.y ?? 1).toBeCloseTo(0, 5);

    const tC = tangents.get('C');
    expect(tC?.x ?? 0).toBeCloseTo(1, 5);
    expect(tC?.y ?? 1).toBeCloseTo(0, 5);
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
