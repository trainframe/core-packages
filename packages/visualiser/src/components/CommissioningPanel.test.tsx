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

describe('CommissioningPanel — scan → commission → device row shows name + length', () => {
  it('drives the real UI: a registered train is named + measured, then surfaces in the roster', () => {
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

    // Operator names it and enters the measured length, then confirms.
    act(() =>
      fireEvent.change(within(row).getByTestId('commission-name-T1'), {
        target: { value: 'Flying Scotsman' },
      }),
    );
    act(() =>
      fireEvent.change(within(row).getByTestId('commission-length-T1'), {
        target: { value: '180' },
      }),
    );
    act(() => fireEvent.click(within(row).getByTestId('commission-confirm-T1')));

    // The UI → ViewModel → broker path published a device re-announce with the profile.
    const reg = client.published.find((m) => m.topic === 'railway/events/device_registered/T1');
    expect(reg).toBeDefined();
    const payload = (
      JSON.parse(new TextDecoder().decode(reg?.payload ?? new Uint8Array())) as {
        payload: { name?: string; train_length_mm?: number };
      }
    ).payload;
    expect(payload).toMatchObject({ name: 'Flying Scotsman', train_length_mm: 180 });

    // Item left the commission queue.
    expect(screen.queryByTestId('commission-item-T1')).toBeNull();

    // The server merges name/livery/length into the retained snapshot (proven in
    // core). Simulate that echo; the DEVICE ROW then shows the name + length.
    deliverDevice(client, 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
      name: 'Flying Scotsman',
      train_length_mm: 180,
    });

    const deviceRow = screen.getByTestId('device-row-T1');
    expect(deviceRow.textContent).toContain('Flying Scotsman');
    expect(within(deviceRow).getByTestId('device-length-T1').textContent).toBe('180 mm');
  });

  it('shows an empty hint when nothing awaits commissioning', () => {
    const client = new InMemoryBrokerSubscriber();
    client.connect('inmem://');
    renderUi(client);
    expect(screen.getByTestId('commissioning-empty')).toBeTruthy();
  });
});
