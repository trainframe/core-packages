/**
 * Framework-independent registered-devices data plane.
 *
 * ## Pattern for e-paper / non-React consumers
 *
 * This file illustrates the extraction pattern used across the visualiser's
 * state hooks. Each "view" class:
 *   1. Takes a `BrokerSubscriber` in its constructor.
 *   2. Owns the topic subscription and state-derivation logic.
 *   3. Exposes `getState()` — always returns the same reference when nothing
 *      changed, so React's `useSyncExternalStore` and memoisation stay stable.
 *   4. Exposes `subscribe(listener)` — ref-counted: subscribes to the broker
 *      on the first listener and unsubscribes on the last, so the class
 *      manages its own teardown.
 *   5. Is entirely React-free; the `use-*` hooks are thin wrappers that
 *      bridge into React's render cycle via `useSyncExternalStore`.
 *
 * An e-paper / alternative-framework consumer can:
 *   import { RegisteredDevicesView } from '@trainframe/visualiser/view';
 *   const view = new RegisteredDevicesView(client);
 *   view.subscribe(() => render(view.getState()));
 */

import type { BrokerMessage, BrokerSubscriber } from '../broker/client.js';

/** A single device the server has seen announce itself on the bus. */
export interface RegisteredDevice {
  readonly device_id: string;
  readonly capabilities: ReadonlyArray<string>;
}

export type RegisteredDevices = ReadonlyMap<string, RegisteredDevice>;

type Listener = () => void;

/**
 * Subscribes to every retained device snapshot on `railway/state/devices/+`
 * and surfaces them as a map keyed by `device_id`.
 *
 * Reference stability: `getState()` returns the previous map reference
 * unchanged when an incoming snapshot carries identical capabilities for a
 * known device. This keeps `useSyncExternalStore` and downstream `useMemo`
 * derivations quiet.
 */
export class RegisteredDevicesView {
  private state: RegisteredDevices = new Map<string, RegisteredDevice>();
  private readonly listeners = new Set<Listener>();
  private unsubscribeBroker: (() => void) | null = null;

  constructor(private readonly client: BrokerSubscriber) {}

  getState = (): RegisteredDevices => this.state;

  subscribe = (listener: Listener): (() => void) => {
    if (this.listeners.size === 0) {
      // First listener — wire up the broker subscription.
      this.unsubscribeBroker = this.client.subscribe('railway/state/devices/+', this.handleMessage);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.unsubscribeBroker) {
        // Last listener — tear down the broker subscription.
        this.unsubscribeBroker();
        this.unsubscribeBroker = null;
      }
    };
  };

  private handleMessage = (message: BrokerMessage): void => {
    const deviceId = message.topic.split('/').pop();
    if (!deviceId) return;
    const parsed = decodeDevicePayload(message.payload);
    const prev = this.state;
    if (parsed === null) {
      if (!prev.has(deviceId)) return;
      const next = new Map(prev);
      next.delete(deviceId);
      this.state = next;
    } else {
      const existing = prev.get(deviceId);
      if (existing && capabilitiesEqual(existing.capabilities, parsed.capabilities)) return;
      const next = new Map(prev);
      next.set(deviceId, { device_id: deviceId, capabilities: parsed.capabilities });
      this.state = next;
    }
    for (const listener of this.listeners) listener();
  };
}

function capabilitiesEqual(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function decodeDevicePayload(payload: Uint8Array): { capabilities: ReadonlyArray<string> } | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !('capabilities' in parsed)) {
    return null;
  }
  const caps = (parsed as { capabilities: unknown }).capabilities;
  if (!Array.isArray(caps) || !caps.every((c): c is string => typeof c === 'string')) {
    return null;
  }
  return { capabilities: caps };
}
