/**
 * Vanilla (React-free) tests for RegisteredDevicesView.
 *
 * These tests prove the data-plane extraction works in isolation: no DOM,
 * no React, no renderHook. An e-paper or other non-React consumer should
 * be able to drive the view exactly this way.
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { RegisteredDevicesView } from './registered-devices-view.js';

function setup() {
  const client = new InMemoryBrokerSubscriber();
  client.connect('ws://test');
  const view = new RegisteredDevicesView(client);
  return { client, view };
}

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

describe('RegisteredDevicesView (vanilla, no React)', () => {
  it('starts with an empty map before any subscriber wires up', () => {
    const { view } = setup();
    expect(view.getState().size).toBe(0);
  });

  it('does not process messages before subscribe() is called', () => {
    const { client, view } = setup();
    // Deliver without subscribing — view is inert until a consumer calls subscribe().
    deliverDevice(client, 'T1', ['core.controls_motion']);
    expect(view.getState().size).toBe(0);
  });

  it('processes messages and calls listener after subscribe()', () => {
    const { client, view } = setup();
    const listener = vi.fn();
    const unsub = view.subscribe(listener);

    deliverDevice(client, 'T1', ['core.controls_motion', 'core.accepts_route']);
    deliverDevice(client, 'GATE-M3', ['core.gates_clearance']);

    expect(view.getState().size).toBe(2);
    expect(view.getState().get('T1')?.capabilities).toEqual([
      'core.controls_motion',
      'core.accepts_route',
    ]);
    expect(view.getState().get('GATE-M3')?.capabilities).toEqual(['core.gates_clearance']);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('drops a device on empty payload and notifies listener', () => {
    const { client, view } = setup();
    const listener = vi.fn();
    const unsub = view.subscribe(listener);

    deliverDevice(client, 'T1', ['core.controls_motion']);
    expect(view.getState().has('T1')).toBe(true);

    client.deliver({
      topic: 'railway/state/devices/T1',
      payload: new TextEncoder().encode(''),
    });

    expect(view.getState().has('T1')).toBe(false);
    // listener called once for add, once for remove
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('returns the same state reference when an unchanged snapshot is re-delivered', () => {
    const { client, view } = setup();
    const unsub = view.subscribe(() => {});

    deliverDevice(client, 'GARAGE', ['core.assigns_tags']);
    const first = view.getState();

    deliverDevice(client, 'GARAGE', ['core.assigns_tags']);
    expect(view.getState()).toBe(first);

    unsub();
  });

  it('does not call listener when snapshot is a no-op', () => {
    const { client, view } = setup();
    const listener = vi.fn();
    const unsub = view.subscribe(listener);

    deliverDevice(client, 'GARAGE', ['core.assigns_tags']);
    const callsBefore = listener.mock.calls.length;

    deliverDevice(client, 'GARAGE', ['core.assigns_tags']); // no-op
    expect(listener.mock.calls.length).toBe(callsBefore);

    unsub();
  });

  it('ignores garbage payloads without notifying', () => {
    const { client, view } = setup();
    const listener = vi.fn();
    const unsub = view.subscribe(listener);

    client.deliver({
      topic: 'railway/state/devices/T1',
      payload: new TextEncoder().encode('not-json'),
    });
    client.deliver({
      topic: 'railway/state/devices/T2',
      payload: new TextEncoder().encode(JSON.stringify({ no_caps: true })),
    });
    client.deliver({
      topic: 'railway/state/devices/T3',
      payload: new TextEncoder().encode(JSON.stringify({ capabilities: 'not-an-array' })),
    });

    expect(view.getState().size).toBe(0);
    expect(listener).not.toHaveBeenCalled();

    unsub();
  });

  it('unsubscribes from broker when the last listener is removed', () => {
    const { client, view } = setup();
    const unsub = view.subscribe(() => {});
    unsub();

    // After unsubscribing, messages should not update state.
    deliverDevice(client, 'T1', ['core.controls_motion']);
    expect(view.getState().size).toBe(0);
  });

  it('re-subscribes to broker when a new listener is added after teardown', () => {
    const { client, view } = setup();

    const unsub1 = view.subscribe(() => {});
    deliverDevice(client, 'T1', ['core.controls_motion']);
    expect(view.getState().size).toBe(1);
    unsub1();

    // After full teardown, re-subscribe and verify broker wires back up.
    const unsub2 = view.subscribe(() => {});
    deliverDevice(client, 'T2', ['core.gates_clearance']);
    expect(view.getState().size).toBe(2);
    unsub2();
  });
});
