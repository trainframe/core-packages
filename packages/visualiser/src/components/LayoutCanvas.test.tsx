import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { LayoutCanvas } from './LayoutCanvas.js';

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
