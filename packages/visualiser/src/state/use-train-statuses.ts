// TODO: extract — see src/view/index.ts for the extraction pattern (TrainStatusesView).
import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * Position-ish info derived from the latest `train_status` event per train.
 * The visualiser uses this to render trains mid-edge rather than snapping
 * to the most recently traversed marker.
 */
export interface TrainStatus {
  readonly train_id: string;
  readonly current_edge?: { from_marker_id: string; to_marker_id: string };
  readonly distance_into_edge_mm?: number;
  readonly speed_normalised: number;
}

export type TrainStatuses = ReadonlyMap<string, TrainStatus>;

export function useTrainStatuses(): TrainStatuses {
  const { client } = useBroker();
  const [statuses, setStatuses] = useState<Map<string, TrainStatus>>(() => new Map());

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parseStatus(message.payload);
      if (!parsed) return;
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(parsed.train_id, parsed);
        return next;
      });
    };
    return client.subscribe('railway/events/train_status/+', handler);
  }, [client]);

  // Drop a train when the broker tells us its device disconnected — without
  // this the last train_status is sticky forever, including across Stop.
  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const trainId = trainIdFromDisconnect(message.topic);
      if (!trainId) return;
      setStatuses((prev) => {
        if (!prev.has(trainId)) return prev;
        const next = new Map(prev);
        next.delete(trainId);
        return next;
      });
    };
    return client.subscribe('railway/events/device_disconnected/+', handler);
  }, [client]);

  return statuses;
}

function trainIdFromDisconnect(topic: string): string | null {
  const parts = topic.split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'railway' || parts[1] !== 'events' || parts[2] !== 'device_disconnected') {
    return null;
  }
  return parts[3] ?? null;
}

function parseStatus(payload: Uint8Array): TrainStatus | null {
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
  const inner = isObjectWithPayload(raw) ? (raw as { payload: unknown }).payload : raw;
  if (typeof inner !== 'object' || inner === null) return null;
  const obj = inner as Record<string, unknown>;
  if (typeof obj.train_id !== 'string') return null;
  const speed = typeof obj.speed_normalised === 'number' ? obj.speed_normalised : 0;
  const status: TrainStatus = {
    train_id: obj.train_id,
    speed_normalised: speed,
    ...extractEdge(obj),
    ...(typeof obj.estimated_distance_from_edge_start_mm === 'number'
      ? { distance_into_edge_mm: obj.estimated_distance_from_edge_start_mm }
      : {}),
  };
  return status;
}

function extractEdge(obj: Record<string, unknown>): {
  current_edge?: { from_marker_id: string; to_marker_id: string };
} {
  const edge = obj.current_edge;
  if (typeof edge !== 'object' || edge === null) return {};
  const e = edge as Record<string, unknown>;
  if (typeof e.from_marker_id !== 'string' || typeof e.to_marker_id !== 'string') return {};
  return {
    current_edge: { from_marker_id: e.from_marker_id, to_marker_id: e.to_marker_id },
  };
}

function isObjectWithPayload(value: unknown): value is { payload: unknown } {
  return typeof value === 'object' && value !== null && 'payload' in value;
}
