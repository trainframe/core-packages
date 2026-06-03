import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * A single device the server has seen announce itself on the bus. Built from
 * the retained `railway/state/devices/<device_id>` snapshot the server
 * publishes when a `device_registered` event lands. An empty retained
 * payload (sent on disconnect) drops the device from the map.
 *
 * This is the post-binding analog to `useUnknownTags`: once a device is
 * registered, the operator wants to *see* it; `useUnknownTags` covers the
 * pre-binding case.
 */
export interface RegisteredDevice {
  readonly device_id: string;
  readonly capabilities: ReadonlyArray<string>;
}

export type RegisteredDevices = ReadonlyMap<string, RegisteredDevice>;

/**
 * Subscribe to every retained device snapshot and surface them as a map keyed
 * by `device_id`. Updates collapse duplicates by reference: re-receiving the
 * same capabilities for a known device returns the previous state object so
 * downstream `useMemo`-d derivations don't churn.
 */
export function useRegisteredDevices(): RegisteredDevices {
  const { client } = useBroker();
  const [devices, setDevices] = useState<ReadonlyMap<string, RegisteredDevice>>(
    () => new Map<string, RegisteredDevice>(),
  );

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const deviceId = message.topic.split('/').pop();
      if (!deviceId) return;
      const parsed = decodeDevicePayload(message.payload);
      setDevices((prev) => {
        if (parsed === null) {
          if (!prev.has(deviceId)) return prev;
          const next = new Map(prev);
          next.delete(deviceId);
          return next;
        }
        const existing = prev.get(deviceId);
        if (existing && capabilitiesEqual(existing.capabilities, parsed.capabilities)) {
          return prev;
        }
        const next = new Map(prev);
        next.set(deviceId, { device_id: deviceId, capabilities: parsed.capabilities });
        return next;
      });
    };
    return client.subscribe('railway/state/devices/+', handler);
  }, [client]);

  return devices;
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
