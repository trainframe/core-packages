import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/*
 * How many completed edges to retain per train (most-recent-first).
 * One previous edge is enough for tail-clamping; keep 8 as a cheap buffer
 * in case a future consumer wants deeper history without a new hook.
 */
const MAX_HISTORY = 8;

/**
 * A directed edge reference stored in the history ring for one train.
 * Matches the `inferred_edge` shape in MarkerTraversed protocol payloads.
 */
export interface CompletedEdge {
  readonly from_marker_id: string;
  readonly to_marker_id: string;
}

/*
 * Per-train ring of recently completed edges, most-recent-first.
 * The visualiser uses entry [0] to find where the tail sits when the head
 * has already moved onto the next edge; entry [0].to_marker_id should
 * equal the head's current_edge.from_marker_id when the train just
 * crossed that marker.
 */
export type TrainEdgeHistory = ReadonlyMap<string, ReadonlyArray<CompletedEdge>>;

export function useTrainEdgeHistory(): TrainEdgeHistory {
  const { client } = useBroker();
  const [history, setHistory] = useState<Map<string, ReadonlyArray<CompletedEdge>>>(
    () => new Map(),
  );

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parseTraversal(message.payload);
      if (!parsed) return;
      const { train_id, inferred_edge } = parsed;
      if (!inferred_edge) return;
      setHistory((prev) => {
        const existing = prev.get(train_id) ?? [];
        /* Prepend the newly completed edge; cap at MAX_HISTORY. */
        const updated: ReadonlyArray<CompletedEdge> = [inferred_edge, ...existing].slice(
          0,
          MAX_HISTORY,
        );
        const next = new Map(prev);
        next.set(train_id, updated);
        return next;
      });
    };
    return client.subscribe('railway/events/marker_traversed/+', handler);
  }, [client]);

  /* Clear a train's history when it disconnects (mirrors other hooks). */
  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const trainId = trainIdFromDisconnect(message.topic);
      if (!trainId) return;
      setHistory((prev) => {
        if (!prev.has(trainId)) return prev;
        const next = new Map(prev);
        next.delete(trainId);
        return next;
      });
    };
    return client.subscribe('railway/events/device_disconnected/+', handler);
  }, [client]);

  return history;
}

/* ── parsers ───────────────────────────────────────────────────────────── */

interface TraversalPayload {
  readonly train_id: string;
  readonly marker_id: string;
  readonly inferred_edge?: CompletedEdge;
}

function parseTraversal(payload: Uint8Array): TraversalPayload | null {
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
  /* Wire events are wrapped in { payload: … } by the server/simulator. */
  const inner = isObjectWithPayload(raw) ? (raw as { payload: unknown }).payload : raw;
  if (typeof inner !== 'object' || inner === null) return null;
  const obj = inner as Record<string, unknown>;
  if (typeof obj.train_id !== 'string' || typeof obj.marker_id !== 'string') return null;
  const inferred_edge = extractEdgeRef(obj.inferred_edge);
  return {
    train_id: obj.train_id,
    marker_id: obj.marker_id,
    ...(inferred_edge !== undefined ? { inferred_edge } : {}),
  };
}

function extractEdgeRef(value: unknown): CompletedEdge | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const e = value as Record<string, unknown>;
  if (typeof e.from_marker_id !== 'string' || typeof e.to_marker_id !== 'string') {
    return undefined;
  }
  return { from_marker_id: e.from_marker_id, to_marker_id: e.to_marker_id };
}

function isObjectWithPayload(value: unknown): value is { payload: unknown } {
  return typeof value === 'object' && value !== null && 'payload' in value;
}

function trainIdFromDisconnect(topic: string): string | null {
  const parts = topic.split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'railway' || parts[1] !== 'events' || parts[2] !== 'device_disconnected') {
    return null;
  }
  return parts[3] ?? null;
}
