import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { UnknownTags } from './UnknownTags.js';

const LAYOUT = {
  name: 'simple-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
  ],
  edges: [],
  junctions: [],
};

function deliver(client: InMemoryBrokerSubscriber, topic: string, payload: unknown): void {
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

const ADMIN_URL = 'http://127.0.0.1:9999';

interface SetupResult {
  client: InMemoryBrokerSubscriber;
  fetchMock: ReturnType<typeof vi.fn>;
}

function setup(): SetupResult {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <BrokerProvider client={client}>
      <UnknownTags adminApiUrl={ADMIN_URL} />
    </BrokerProvider>,
  );
  // Deliver layout AFTER mount so the hook's subscription is in place.
  act(() => deliver(client, 'railway/state/layout/simple-loop', LAYOUT));
  return { client, fetchMock };
}

describe('UnknownTags', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing until an unknown-tag anomaly arrives', () => {
    setup();
    expect(screen.queryByTestId('unknown-tags')).toBeNull();
  });

  it('surfaces a row when an unknown-tag anomaly arrives', () => {
    const { client } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/anomaly/server', {
        severity: 'info',
        description: 'Unknown tag observed: TAG-9 (not in the tag registry)',
      }),
    );
    expect(screen.getByTestId('unknown-tag-TAG-9')).toBeInTheDocument();
  });

  it('POSTs to /api/tags with the chosen target when the operator submits', async () => {
    const { client, fetchMock } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/anomaly/server', {
        severity: 'info',
        description: 'Unknown tag observed: TAG-9 (not in the tag registry)',
      }),
    );

    const targetSelect = screen.getByTestId('target-TAG-9') as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: 'M2' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: /Assign tag TAG-9/ }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${ADMIN_URL}/api/tags`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tag_id: 'TAG-9', assigned_kind: 'marker', target_id: 'M2' }),
      }),
    );
  });

  it('removes the row when the registry retained state for the tag arrives', () => {
    const { client } = setup();
    act(() =>
      deliverEvent(client, 'railway/events/anomaly/server', {
        severity: 'info',
        description: 'Unknown tag observed: TAG-9 (not in the tag registry)',
      }),
    );
    expect(screen.getByTestId('unknown-tag-TAG-9')).toBeInTheDocument();

    act(() =>
      deliver(client, 'railway/state/tags/TAG-9', {
        assigned_kind: 'marker',
        target_id: 'M2',
      }),
    );
    expect(screen.queryByTestId('unknown-tag-TAG-9')).toBeNull();
  });

  it('shows a "Pick a target" error if the operator submits before a layout is available', async () => {
    const client = new InMemoryBrokerSubscriber();
    client.connect('ws://test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <BrokerProvider client={client}>
        <UnknownTags adminApiUrl={ADMIN_URL} />
      </BrokerProvider>,
    );
    act(() =>
      deliverEvent(client, 'railway/events/anomaly/server', {
        severity: 'info',
        description: 'Unknown tag observed: TAG-9 (not in the tag registry)',
      }),
    );

    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: /Assign tag TAG-9/ }));
    });

    expect(screen.getByTestId('assign-error-TAG-9')).toHaveTextContent(/Pick a target/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a server error on failed submission', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":"target unknown"}',
    });
    act(() =>
      deliverEvent(client, 'railway/events/anomaly/server', {
        severity: 'info',
        description: 'Unknown tag observed: TAG-9 (not in the tag registry)',
      }),
    );
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: /Assign tag TAG-9/ }));
    });
    expect(screen.getByTestId('assign-error-TAG-9')).toHaveTextContent(/400/);
  });
});
