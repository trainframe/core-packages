import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * The set of currently-registered trains. A train is any device that
 * declared the `core.controls_motion` capability at registration. Rebuilt
 * from retained `railway/state/devices/<device_id>` messages; empty
 * snapshots (sent on disconnect) remove the train.
 */
export type RegisteredTrains = ReadonlyArray<string>;

export function useRegisteredTrains(): RegisteredTrains {
  const { client } = useBroker();
  const [trains, setTrains] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const trainId = message.topic.split('/').pop();
      if (!trainId) return;
      const parsed = decodeDevicePayload(message.payload);
      setTrains((prev) => {
        const has = prev.has(trainId);
        // Train: capabilities array contains core.controls_motion.
        const isTrain = parsed?.capabilities.some((c) => c === 'core.controls_motion') === true;
        if (parsed === null || !isTrain) {
          if (!has) return prev;
          const next = new Set(prev);
          next.delete(trainId);
          return next;
        }
        if (has) return prev;
        const next = new Set(prev);
        next.add(trainId);
        return next;
      });
    };
    return client.subscribe('railway/state/devices/+', handler);
  }, [client]);

  // Stable sorted array so the dropdown order doesn't shuffle.
  return [...trains].sort();
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
