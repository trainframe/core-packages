import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * A train-introduction conflict as reported by the server on
 * `railway/events/train_introduction_conflict/+`.
 *
 * Emitted when a roll-path introduction attempt finds the contested block
 * already occupied (ADR-036 §5).
 */
export interface IntroductionConflict {
  readonly train_id: string;
  readonly conflicting_train_id: string;
  readonly block_edge: {
    readonly from_marker_id: string;
    readonly to_marker_id: string;
  };
  readonly reason: string;
}

/**
 * Subscribe to `railway/events/train_introduction_conflict/+` and surface
 * the most-recent conflict. Returns `null` when no conflict has been seen
 * since mount.
 */
export function useIntroductionConflict(): IntroductionConflict | null {
  const { client } = useBroker();
  const [conflict, setConflict] = useState<IntroductionConflict | null>(null);

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parseConflictMessage(message.payload);
      if (parsed !== null) setConflict(parsed);
    };
    return client.subscribe('railway/events/train_introduction_conflict/+', handler);
  }, [client]);

  return conflict;
}

function parseConflictMessage(payload: Uint8Array): IntroductionConflict | null {
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
  /* Accept both bare payload and event-envelope shapes. */
  const bare = extractConflict(parsed);
  if (bare !== null) return bare;
  const enveloped = extractConflict((parsed as { payload?: unknown }).payload);
  return enveloped;
}

function extractConflict(value: unknown): IntroductionConflict | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const trainId = obj.train_id;
  const conflictingId = obj.conflicting_train_id;
  const blockEdge = obj.block_edge;
  const reason = obj.reason;
  if (typeof trainId !== 'string' || trainId.length === 0) return null;
  if (typeof conflictingId !== 'string' || conflictingId.length === 0) return null;
  if (typeof reason !== 'string') return null;
  if (!blockEdge || typeof blockEdge !== 'object') return null;
  const edge = blockEdge as Record<string, unknown>;
  const from = edge.from_marker_id;
  const to = edge.to_marker_id;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  return {
    train_id: trainId,
    conflicting_train_id: conflictingId,
    block_edge: { from_marker_id: from, to_marker_id: to },
    reason,
  };
}
