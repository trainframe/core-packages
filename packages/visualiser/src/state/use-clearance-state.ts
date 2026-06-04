// TODO: extract — see src/view/index.ts for the extraction pattern (ClearanceStateView).
import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * Edge key format: "${from_marker_id}->${to_marker_id}".
 * Matches the key used in LayoutCanvas so lookups are O(1).
 */
type EdgeKey = string;

/**
 * Per-edge clearance map. Keys are edge keys; values are the train ID that
 * currently holds the section. Rebuilt from retained
 * `railway/state/clearance/<train_id>` messages.
 *
 * Invariant: entries for a train are deleted before new ones are added, so
 * the map always reflects the train's current `cleared_edges` array exactly.
 */
export type ClearanceMap = ReadonlyMap<EdgeKey, string>;

interface ClearancePayload {
  readonly train_id: string;
  readonly cleared_edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>;
}

/**
 * Subscribe to `railway/state/clearance/+` and maintain a per-edge map of
 * which train holds each section. The retained flag means fresh subscribers
 * immediately receive the current state of any active train.
 */
export function useClearanceState(): ClearanceMap {
  const { client } = useBroker();
  const [clearance, setClearance] = useState<Map<EdgeKey, string>>(() => new Map());

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parseClearanceMessage(message.payload);
      if (!parsed) return;
      setClearance((prev) => {
        // Remove stale entries for this train, then add the fresh ones.
        // Build a new map only when something actually changed.
        const next = new Map(prev);
        for (const [key, holder] of prev) {
          if (holder === parsed.train_id) next.delete(key);
        }
        for (const edge of parsed.cleared_edges) {
          next.set(`${edge.from_marker_id}->${edge.to_marker_id}`, parsed.train_id);
        }
        return next;
      });
    };
    return client.subscribe('railway/state/clearance/+', handler);
  }, [client]);

  return clearance;
}

function parseClearanceMessage(payload: Uint8Array): ClearancePayload | null {
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
  return isClearanceShape(raw) ? raw : null;
}

function isClearanceShape(value: unknown): value is ClearancePayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.train_id !== 'string') return false;
  if (!Array.isArray(obj.cleared_edges)) return false;
  return obj.cleared_edges.every(isEdgeRef);
}

function isEdgeRef(value: unknown): value is { from_marker_id: string; to_marker_id: string } {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.from_marker_id === 'string' && typeof e.to_marker_id === 'string';
}
