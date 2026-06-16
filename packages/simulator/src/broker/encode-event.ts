import { PROTOCOL_VERSION, topics } from '@trainframe/protocol';

/**
 * Envelope + topic for a device event published from the toy-table UI.
 *
 * Matches `BrokerBridge.publishEvent` in `@trainframe/simulator` so that
 * subscribers (notably the visualiser) can't tell a scan-box-spawned event
 * from one emitted by a real `VirtualTrain` / `VirtualGate` through the
 * bridge. If you change the envelope shape, change both call sites.
 */
export interface EncodedDeviceEvent {
  readonly topic: string;
  readonly payload: Uint8Array;
}

export interface EncodeDeviceEventOptions {
  /** Generates a fresh envelope ID. Defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Returns the current ISO-8601 timestamp. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

/**
 * Build a `(topic, payload)` pair to hand straight to `BrokerClient.publish`
 * for a device event. The result mirrors the BrokerBridge envelope so a
 * server / visualiser on the bus accepts it without special-casing.
 */
export function encodeDeviceEvent(
  event_type: string,
  device_id: string,
  payload: unknown,
  options: EncodeDeviceEventOptions = {},
): EncodedDeviceEvent {
  const newId = options.newId ?? defaultNewId;
  const now = options.now ?? defaultNow;
  const envelope = {
    event_id: newId(),
    device_id,
    timestamp_device: now(),
    event_type,
    protocol_version: PROTOCOL_VERSION,
    payload,
  };
  return {
    topic: topics.event(event_type, device_id),
    payload: new TextEncoder().encode(JSON.stringify(envelope)),
  };
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for very old runtimes — the UI never hits this path in practice.
  return `id-${Math.floor(Math.random() * 1e12).toString(36)}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}
