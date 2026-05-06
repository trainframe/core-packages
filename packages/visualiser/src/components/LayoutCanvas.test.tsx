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
});
