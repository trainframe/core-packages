// TODO: extract — see src/view/index.ts for the extraction pattern (UnknownTagsView).
import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * Anomaly the scheduler emits when an unknown tag is observed
 * (see `Scheduler.handleTagObserved`). The visualiser parses these out of
 * the live event stream so the operator can bind the tag to a marker via
 * the admin HTTP API. Resolved tags drop out as soon as a
 * `railway/state/tags/<id>` retained message lands.
 */
export interface UnknownTag {
  readonly tag_id: string;
  readonly first_seen_at: Date;
}

export type UnknownTags = ReadonlyArray<UnknownTag>;

const UNKNOWN_TAG_PATTERN = /^Unknown tag observed:\s*([^\s)]+)/;

export function useUnknownTags(): UnknownTags {
  const { client } = useBroker();
  const [tags, setTags] = useState<Map<string, UnknownTag>>(() => new Map());

  useEffect(() => {
    // Tags resolved through tag_assignment land as retained state on
    // railway/state/tags/<tag_id>. Drop them from the pending list so the
    // affordance disappears when the operator finishes the assignment.
    const offState = client.subscribe('railway/state/tags/+', (message: BrokerMessage) => {
      const tagId = message.topic.slice('railway/state/tags/'.length);
      if (!tagId) return;
      setTags((prev) => {
        if (!prev.has(tagId)) return prev;
        const next = new Map(prev);
        next.delete(tagId);
        return next;
      });
    });

    const offAnomalies = client.subscribe('railway/events/anomaly/+', (message: BrokerMessage) => {
      const tagId = parseUnknownTagAnomaly(message.payload);
      if (!tagId) return;
      setTags((prev) => {
        if (prev.has(tagId)) return prev;
        const next = new Map(prev);
        next.set(tagId, { tag_id: tagId, first_seen_at: new Date() });
        return next;
      });
    });

    return () => {
      offState();
      offAnomalies();
    };
  }, [client]);

  return [...tags.values()];
}

function parseUnknownTagAnomaly(payload: Uint8Array): string | null {
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
  if (typeof obj.description !== 'string') return null;
  const match = obj.description.match(UNKNOWN_TAG_PATTERN);
  return match?.[1] ?? null;
}

function isObjectWithPayload(value: unknown): value is { payload: unknown } {
  return typeof value === 'object' && value !== null && 'payload' in value;
}
