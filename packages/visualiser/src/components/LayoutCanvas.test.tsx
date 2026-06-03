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

  it('renders one edge per layout edge', () => {
    const { client } = renderCanvas();
    act(() => deliverState(client, 'railway/state/layout/simple-loop', SIMPLE_LOOP_LAYOUT));

    const edges = screen.getByTestId('edges');
    expect(edges.querySelectorAll('line').length).toBe(4);
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
    const lines = edges.querySelectorAll('line');
    expect(lines.length).toBe(2);

    const inferredLine = edges.querySelector('line[data-inferred="true"]');
    expect(inferredLine).not.toBeNull();
    expect(inferredLine?.getAttribute('stroke-dasharray')).toBe('8 6');

    // The confirmed edge should have no data-inferred attribute at all.
    const allLines = Array.from(lines);
    const confirmedLine = allLines.find((l) => !l.hasAttribute('data-inferred'));
    expect(confirmedLine).not.toBeUndefined();
    expect(confirmedLine?.hasAttribute('stroke-dasharray')).toBe(false);
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
    expect(trainNode?.getAttribute('data-on-edge')).toBe('M1->M2');
    const circle = trainNode?.querySelector('circle');
    const markers = screen.getByTestId('markers');
    const m1 = markers.querySelector('[data-marker-id="M1"] circle');
    const m2 = markers.querySelector('[data-marker-id="M2"] circle');
    const trainX = Number(circle?.getAttribute('cx'));
    const trainY = Number(circle?.getAttribute('cy'));
    const expectedX = (Number(m1?.getAttribute('cx')) + Number(m2?.getAttribute('cx'))) / 2;
    const expectedY = (Number(m1?.getAttribute('cy')) + Number(m2?.getAttribute('cy'))) / 2;
    expect(trainX).toBeCloseTo(expectedX, 1);
    expect(trainY).toBeCloseTo(expectedY, 1);
  });

  it('sets data-cleared-to on an edge line when the clearance map holds it', () => {
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
    const clearedLine = edges.querySelector('line[data-cleared-to="T1"]');
    expect(clearedLine).not.toBeNull();

    // The other edges should have an empty data-cleared-to attribute.
    const allLines = Array.from(edges.querySelectorAll('line'));
    const unclearedLines = allLines.filter((l) => l.getAttribute('data-cleared-to') !== 'T1');
    expect(unclearedLines.length).toBe(3);
    for (const line of unclearedLines) {
      expect(line.getAttribute('data-cleared-to')).toBe('');
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
