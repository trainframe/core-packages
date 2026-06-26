import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
/**
 * Commissioning UI binding (goal criterion 4): the React View is a THIN binding
 * over the headless CommissioningView. Driven end-to-end through the real
 * components — a scan appears in the queue → pick Train → name + length →
 * confirm → the device row shows the name + length.
 */
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { CommissioningPanel } from './CommissioningPanel.js';
import { DevicesPanel } from './DevicesPanel.js';

const encode = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

function renderUi(client: InMemoryBrokerSubscriber): void {
  render(
    <BrokerProvider client={client}>
      <CommissioningPanel />
      <DevicesPanel adminApiUrl="http://test" />
    </BrokerProvider>,
  );
}

/** A retained device snapshot, as the server publishes it. */
function deliverDevice(
  client: InMemoryBrokerSubscriber,
  id: string,
  snapshot: Record<string, unknown>,
): void {
  act(() => client.deliver({ topic: `railway/state/devices/${id}`, payload: encode(snapshot) }));
}

describe('CommissioningPanel — scan → commission (no naming) → device row', () => {
  it('drives the real UI: a train is measured (NOT named — ADR-035), then surfaces in the roster', () => {
    const client = new InMemoryBrokerSubscriber();
    client.connect('inmem://');
    renderUi(client);

    // A train appears on the bus with capabilities only (no name).
    deliverDevice(client, 'T1', { capabilities: ['core.controls_motion', 'core.accepts_route'] });

    // It shows up in the commission queue (suggested category = train).
    const row = screen.getByTestId('commission-item-T1');
    expect((within(row).getByTestId('commission-category-T1') as HTMLSelectElement).value).toBe(
      'train',
    );

    // There is NO name prompt — the operator never names a piece (ADR-035).
    expect(within(row).queryByTestId('commission-name-T1')).toBeNull();

    // Operator enters the measured length only, then confirms.
    act(() =>
      fireEvent.change(within(row).getByTestId('commission-length-T1'), {
        target: { value: '180' },
      }),
    );
    act(() => fireEvent.click(within(row).getByTestId('commission-confirm-T1')));

    // The UI → ViewModel → broker path published a device re-announce with the
    // measured length and NO operator name.
    const reg = client.published.find((m) => m.topic === 'railway/events/device_registered/T1');
    expect(reg).toBeDefined();
    const payload = (
      JSON.parse(new TextDecoder().decode(reg?.payload ?? new Uint8Array())) as {
        payload: { name?: string; train_length_mm?: number };
      }
    ).payload;
    expect(payload.train_length_mm).toBe(180);
    expect(payload.name ?? '').toBe(''); // no operator name

    // Item left the commission queue.
    expect(screen.queryByTestId('commission-item-T1')).toBeNull();

    // The server merges the length into the retained snapshot; the DEVICE ROW
    // then shows the length (the device id stands in for a name).
    deliverDevice(client, 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
      train_length_mm: 180,
    });

    const deviceRow = screen.getByTestId('device-row-T1');
    expect(within(deviceRow).getByTestId('device-length-T1').textContent).toBe('180 mm');
  });

  it('shows an empty hint when nothing awaits commissioning', () => {
    const client = new InMemoryBrokerSubscriber();
    client.connect('inmem://');
    renderUi(client);
    expect(screen.getByTestId('commissioning-empty')).toBeTruthy();
  });
});
