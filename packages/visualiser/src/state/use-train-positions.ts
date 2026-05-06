import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * Map of `train_id -> last reported marker_id`. Built up as
 * `marker_traversed` events flow in. The visualiser positions the train icon
 * at the marker's spatial coordinates (or the auto-placed position when no
 * spatial coords exist on the layout).
 */
export type TrainPositions = ReadonlyMap<string, string>;

interface MarkerTraversedPayload {
  readonly train_id: string;
  readonly marker_id: string;
}

export function useTrainPositions(): TrainPositions {
  const { client } = useBroker();
  const [positions, setPositions] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parseTraversal(message.payload);
      if (!parsed) return;
      setPositions((prev) => {
        if (prev.get(parsed.train_id) === parsed.marker_id) return prev;
        const next = new Map(prev);
        next.set(parsed.train_id, parsed.marker_id);
        return next;
      });
    };
    return client.subscribe('railway/events/marker_traversed/+', handler);
  }, [client]);

  return positions;
}

function parseTraversal(payload: Uint8Array): MarkerTraversedPayload | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  // Wire-format event has `payload` field; the simulator-ui publishes that
  // shape. Accept both wrapped and bare payloads to stay loose.
  const inner = isObjectWithPayload(raw) ? (raw as { payload: unknown }).payload : raw;
  if (!isTraversalShape(inner)) return null;
  return inner;
}

function isObjectWithPayload(value: unknown): value is { payload: unknown } {
  return typeof value === 'object' && value !== null && 'payload' in value;
}

function isTraversalShape(value: unknown): value is MarkerTraversedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.train_id === 'string' && typeof obj.marker_id === 'string';
}
