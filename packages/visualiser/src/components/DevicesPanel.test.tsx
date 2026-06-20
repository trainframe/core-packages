import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as adminClient from '../api/admin-client.js';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { DevicesPanel } from './DevicesPanel.js';

function deliverDevice(
  client: InMemoryBrokerSubscriber,
  deviceId: string,
  capabilities: ReadonlyArray<string>,
): void {
  client.deliver({
    topic: `railway/state/devices/${deviceId}`,
    payload: new TextEncoder().encode(JSON.stringify({ capabilities })),
  });
}

function deliverLayout(
  client: InMemoryBrokerSubscriber,
  name: string,
  markers: ReadonlyArray<{ id: string; kind: string }>,
  edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
): void {
  client.deliver({
    topic: `railway/state/layout/${name}`,
    payload: new TextEncoder().encode(JSON.stringify({ name, markers, edges })),
  });
}

function deliverSchedule(
  client: InMemoryBrokerSubscriber,
  trainId: string,
  routeId: string,
  stops: ReadonlyArray<string>,
  currentIndex: number,
): void {
  client.deliver({
    topic: `railway/state/schedule/${trainId}`,
    payload: new TextEncoder().encode(
      JSON.stringify({
        train_id: trainId,
        route_id: routeId,
        stops,
        current_stop_index: currentIndex,
      }),
    ),
  });
}

function deliverMarkerTraversed(
  client: InMemoryBrokerSubscriber,
  trainId: string,
  markerId: string,
): void {
  client.deliver({
    topic: `railway/events/marker_traversed/${trainId}`,
    payload: new TextEncoder().encode(
      JSON.stringify({ payload: { train_id: trainId, marker_id: markerId } }),
    ),
  });
}

function deliverTagObserved(client: InMemoryBrokerSubscriber, deviceId: string, tagId: string) {
  client.deliver({
    topic: `railway/events/tag_observed/${deviceId}`,
    payload: new TextEncoder().encode(JSON.stringify({ payload: { tag_id: tagId } })),
  });
}

const TEST_ADMIN_URL = 'http://127.0.0.1:3000';

function renderPanel() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const utils = render(
    <BrokerProvider client={client}>
      <DevicesPanel adminApiUrl={TEST_ADMIN_URL} />
    </BrokerProvider>,
  );
  return { client, ...utils };
}

describe('DevicesPanel', () => {
  it('renders all four section headings even on an empty bus', () => {
    renderPanel();
    expect(screen.getByTestId('devices-panel')).toBeInTheDocument();
    expect(screen.getByText('Trains')).toBeInTheDocument();
    expect(screen.getByText('Gates')).toBeInTheDocument();
    expect(screen.getByText('Garages')).toBeInTheDocument();
    expect(screen.getByText('Markers')).toBeInTheDocument();
  });

  it('shows registered devices in their right buckets and reports counts', async () => {
    const { client } = renderPanel();
    act(() => {
      deliverDevice(client, 'T1', ['core.controls_motion']);
      deliverDevice(client, 'GATE-M3', ['core.gates_clearance']);
      deliverDevice(client, 'GARAGE', ['core.assigns_tags']);
      deliverLayout(
        client,
        'demo',
        [
          { id: 'M1', kind: 'station_stop' },
          { id: 'M2', kind: 'junction' },
        ],
        [{ from_marker_id: 'M1', to_marker_id: 'M2' }],
      );
    });
    await waitFor(() => expect(screen.getByTestId('device-row-T1')).toBeInTheDocument());
    expect(screen.getByTestId('device-row-GATE-M3')).toBeInTheDocument();
    expect(screen.getByTestId('device-row-GARAGE')).toBeInTheDocument();
    expect(screen.getByTestId('device-row-M1')).toBeInTheDocument();
    expect(screen.getByTestId('device-row-M2')).toBeInTheDocument();

    expect(screen.getByTestId('devices-trains-group-count')).toHaveTextContent('1');
    expect(screen.getByTestId('devices-gates-group-count')).toHaveTextContent('1');
    expect(screen.getByTestId('devices-garages-group-count')).toHaveTextContent('1');
    expect(screen.getByTestId('devices-markers-group-count')).toHaveTextContent('2');
  });

  it('reports inbound and outbound edge counts for each marker', async () => {
    const { client } = renderPanel();
    act(() => {
      deliverLayout(
        client,
        'demo',
        [
          { id: 'M1', kind: 'block_boundary' },
          { id: 'M2', kind: 'block_boundary' },
          { id: 'M3', kind: 'block_boundary' },
        ],
        [
          { from_marker_id: 'M1', to_marker_id: 'M2' },
          { from_marker_id: 'M2', to_marker_id: 'M3' },
          { from_marker_id: 'M3', to_marker_id: 'M2' },
        ],
      );
    });
    const m2 = await screen.findByTestId('device-row-M2');
    // M2: inbound from M1 and M3 (2), outbound to M3 (1).
    expect(within(m2).getByText('2 in / 1 out')).toBeInTheDocument();
  });

  it('shows schedule and position info for a train when available', async () => {
    const { client } = renderPanel();
    act(() => {
      deliverDevice(client, 'T1', ['core.controls_motion']);
      deliverSchedule(client, 'T1', 'r-1', ['M1', 'M2'], 0);
      deliverMarkerTraversed(client, 'T1', 'M1');
    });
    const row = await screen.findByTestId('device-row-T1');
    expect(within(row).getByText(/route M1 → M2/)).toBeInTheDocument();
    expect(within(row).getByText(/at M1/)).toBeInTheDocument();
  });

  it('highlights a marker row when a tag_observed event names its id', async () => {
    const { client } = renderPanel();
    act(() => {
      deliverLayout(client, 'demo', [{ id: 'M1', kind: 'station_stop' }], []);
    });
    const row = await screen.findByTestId('device-row-M1');
    expect(row).not.toHaveAttribute('data-highlighted');
    act(() => deliverTagObserved(client, 'T1', 'M1'));
    await waitFor(() =>
      expect(screen.getByTestId('device-row-M1')).toHaveAttribute('data-highlighted', 'true'),
    );
  });

  it('highlights a device row when its id arrives as a scan target', async () => {
    const { client } = renderPanel();
    act(() => deliverDevice(client, 'T1', ['core.controls_motion']));
    await screen.findByTestId('device-row-T1');
    act(() => deliverTagObserved(client, 'TRACKER', 'T1'));
    await waitFor(() =>
      expect(screen.getByTestId('device-row-T1')).toHaveAttribute('data-highlighted', 'true'),
    );
  });

  it('shows an empty hint for every group on an empty bus', () => {
    renderPanel();
    expect(screen.getByText(/No trains registered yet\./)).toBeInTheDocument();
    expect(screen.getByText(/No gating devices registered yet\./)).toBeInTheDocument();
    expect(screen.getByText(/No tag-assigning devices registered yet\./)).toBeInTheDocument();
    expect(screen.getByText(/No markers on the layout yet\./)).toBeInTheDocument();
  });

  it('deletes a train from memory via the admin client', async () => {
    const deleteSpy = vi.spyOn(adminClient, 'deleteTrain').mockResolvedValue();
    const { client } = renderPanel();
    act(() => {
      deliverDevice(client, 'T1', ['core.controls_motion']);
    });
    await screen.findByTestId('device-row-T1');
    fireEvent.click(
      within(screen.getByTestId('device-row-T1')).getByRole('button', { name: /delete/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('http://127.0.0.1:3000', 'T1'));
  });

  it('surfaces delete errors inline on the train row', async () => {
    const deleteSpy = vi.spyOn(adminClient, 'deleteTrain').mockRejectedValue(new Error('boom'));
    const { client } = renderPanel();
    act(() => {
      deliverDevice(client, 'T1', ['core.controls_motion']);
    });
    await screen.findByTestId('device-row-T1');
    fireEvent.click(
      within(screen.getByTestId('device-row-T1')).getByRole('button', { name: /delete/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('http://127.0.0.1:3000', 'T1'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('boom');
  });
});
