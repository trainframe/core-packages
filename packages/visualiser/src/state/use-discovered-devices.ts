import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * An unpaired device the bridge announced via `device_discovered` (ADR-035): the
 * garage surfaces these so the operator can scan a tag and complete association
 * with ONE gesture. A discovered device drops off the list the moment it
 * registers (its retained `railway/state/devices/<device_id>` lands) — i.e. once
 * association resolved its identity. No naming is asked of the operator; the
 * device self-declares its kind.
 */
export interface DiscoveredDevice {
  readonly device_ref: string;
  readonly device_id: string;
  readonly device_kind_hint: string;
  readonly first_seen_at: Date;
}

/** The device id the garage publishes association events under. */
const GARAGE_ID = 'VISUALISER-GARAGE';

export interface DiscoveredDevices {
  readonly pending: ReadonlyArray<DiscoveredDevice>;
  /** Bind a discovered device to the marker the operator just scanned. */
  readonly associate: (deviceRef: string, tagId: string) => void;
}

export function useDiscoveredDevices(): DiscoveredDevices {
  const { client } = useBroker();
  const [devices, setDevices] = useState<Map<string, DiscoveredDevice>>(() => new Map());

  useEffect(() => {
    const offDiscovered = client.subscribe(
      'railway/events/device_discovered/+',
      (message: BrokerMessage) => {
        const d = parseDiscovered(message);
        if (d === null) return;
        setDevices((prev) => {
          if (prev.has(d.device_ref)) return prev;
          const next = new Map(prev);
          next.set(d.device_ref, d);
          return next;
        });
      },
    );
    /* A device that registers (its retained device state lands) is no longer
       pending — association resolved it. Drop by device_id. */
    const offRegistered = client.subscribe('railway/state/devices/+', (message: BrokerMessage) => {
      const deviceId = message.topic.slice('railway/state/devices/'.length);
      if (!deviceId) return;
      setDevices((prev) => {
        let hit = false;
        const next = new Map<string, DiscoveredDevice>();
        for (const [ref, d] of prev) {
          if (d.device_id === deviceId) hit = true;
          else next.set(ref, d);
        }
        return hit ? next : prev;
      });
    });
    return () => {
      offDiscovered();
      offRegistered();
    };
  }, [client]);

  const associate = (deviceRef: string, tagId: string): void => {
    client.publish(
      `railway/events/device_association/${GARAGE_ID}`,
      new TextEncoder().encode(
        JSON.stringify({
          event_id: crypto.randomUUID(),
          device_id: GARAGE_ID,
          timestamp_device: new Date().toISOString(),
          event_type: 'device_association',
          protocol_version: PROTOCOL_VERSION,
          payload: { device_ref: deviceRef, tag_id: tagId },
        }),
      ),
    );
  };

  return { pending: [...devices.values()], associate };
}

function parseDiscovered(message: BrokerMessage): DiscoveredDevice | null {
  const deviceId = message.topic.slice('railway/events/device_discovered/'.length);
  if (!deviceId) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(message.payload));
  } catch {
    return null;
  }
  const env = raw as { payload?: { device_ref?: unknown; device_kind_hint?: unknown } };
  const ref = env.payload?.device_ref;
  const kind = env.payload?.device_kind_hint;
  if (typeof ref !== 'string' || typeof kind !== 'string') return null;
  return {
    device_ref: ref,
    device_id: deviceId,
    device_kind_hint: kind,
    first_seen_at: new Date(),
  };
}
