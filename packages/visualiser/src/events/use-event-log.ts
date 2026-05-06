import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * One row in the live event log. We deliberately parse loosely: the visualiser
 * is presentational, so we treat malformed JSON or non-conforming envelopes
 * as displayable strings rather than rejecting them. Schema enforcement is
 * the broker boundary's job.
 */
export interface EventLogEntry {
  /** Monotonic id assigned in-browser; not the protocol event_id. */
  readonly id: number;
  /** Wall-clock time the entry was received in the browser. */
  readonly received_at: Date;
  /** Raw MQTT topic. */
  readonly topic: string;
  /** Parsed topic kind, when the topic matches the protocol convention. */
  readonly kind: 'core' | 'custom' | 'unknown';
  /** Event type when parseable, otherwise the empty string. */
  readonly event_type: string;
  /** Device id when parseable, otherwise the empty string. */
  readonly device_id: string;
  /** Vendor segment for custom events, otherwise undefined. */
  readonly vendor?: string;
  /** Decoded payload as a JS value when JSON-parseable, otherwise the raw text. */
  readonly payload: unknown;
}

const MAX_ENTRIES = 100;

interface UseEventLogOptions {
  /** Topic filter — defaults to all events. */
  readonly topicFilter?: string;
  /** Cap on retained entries. Older entries are dropped. */
  readonly maxEntries?: number;
}

/**
 * Subscribe to a broker topic and surface incoming messages as a rolling log.
 * Re-subscribes whenever the underlying client changes (e.g. on reconnect).
 */
export function useEventLog(options: UseEventLogOptions = {}): ReadonlyArray<EventLogEntry> {
  const { client } = useBroker();
  const topic = options.topicFilter ?? 'railway/events/#';
  const cap = options.maxEntries ?? MAX_ENTRIES;
  const [entries, setEntries] = useState<EventLogEntry[]>([]);

  useEffect(() => {
    let nextId = 0;
    const handle = (message: BrokerMessage) => {
      const entry = toEntry(nextId++, message);
      setEntries((prev) => appendCapped(prev, entry, cap));
    };
    return client.subscribe(topic, handle);
  }, [client, topic, cap]);

  return entries;
}

function appendCapped(prev: EventLogEntry[], entry: EventLogEntry, cap: number): EventLogEntry[] {
  const next = prev.length >= cap ? prev.slice(prev.length - cap + 1) : prev;
  return [...next, entry];
}

function toEntry(id: number, message: BrokerMessage): EventLogEntry {
  const text = decodePayload(message.payload);
  return {
    id,
    received_at: new Date(),
    topic: message.topic,
    payload: parseJsonOrFallback(text),
    ...parseTopic(message.topic),
  };
}

function decodePayload(payload: Uint8Array): string {
  try {
    return new TextDecoder().decode(payload);
  } catch {
    return '';
  }
}

function parseJsonOrFallback(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseTopic(
  topic: string,
):
  | { kind: 'core'; event_type: string; device_id: string }
  | { kind: 'custom'; vendor: string; event_type: string; device_id: string }
  | { kind: 'unknown'; event_type: ''; device_id: '' } {
  const parts = topic.split('/');
  if (parts[0] !== 'railway' || parts[1] !== 'events') {
    return { kind: 'unknown', event_type: '', device_id: '' };
  }
  if (parts[2] === 'custom') {
    const vendor = parts[3];
    const event_type = parts[4];
    const device_id = parts[5];
    if (parts.length === 6 && vendor && event_type && device_id) {
      return { kind: 'custom', vendor, event_type, device_id };
    }
    return { kind: 'unknown', event_type: '', device_id: '' };
  }
  const event_type = parts[2];
  const device_id = parts[3];
  if (parts.length === 4 && event_type && device_id) {
    return { kind: 'core', event_type, device_id };
  }
  return { kind: 'unknown', event_type: '', device_id: '' };
}
