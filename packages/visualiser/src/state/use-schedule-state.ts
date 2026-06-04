// TODO: extract — see src/view/index.ts for the extraction pattern (ScheduleStateView).
import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * The operator-facing schedule for a single train, as published by the
 * scheduler. Mirrors `TrainState.schedule` from `@trainframe/core`.
 */
export interface ScheduleEntry {
  readonly train_id: string;
  readonly route_id: string;
  readonly stops: ReadonlyArray<string>;
  readonly current_stop_index: number;
}

/**
 * Map of train ID → its current schedule. Entries are added/updated on
 * incoming snapshots and removed when the snapshot's stops are empty
 * (e.g. a despawned train). The visualiser renders this directly.
 */
export type ScheduleMap = ReadonlyMap<string, ScheduleEntry>;

/**
 * Subscribe to `railway/state/schedule/+` and surface the current schedule
 * for each registered train. Retained on the broker so fresh subscribers
 * see all active schedules immediately.
 */
export function useScheduleState(): ScheduleMap {
  const { client } = useBroker();
  const [schedules, setSchedules] = useState<Map<string, ScheduleEntry>>(() => new Map());

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parseScheduleMessage(message.payload);
      if (!parsed) return;
      setSchedules((prev) => {
        const next = new Map(prev);
        if (parsed.kind === 'remove') {
          next.delete(parsed.train_id);
        } else {
          next.set(parsed.entry.train_id, parsed.entry);
        }
        return next;
      });
    };
    return client.subscribe('railway/state/schedule/+', handler);
  }, [client]);

  return schedules;
}

type ParsedMessage = { kind: 'set'; entry: ScheduleEntry } | { kind: 'remove'; train_id: string };

function parseScheduleMessage(payload: Uint8Array): ParsedMessage | null {
  const parsed = decodeJson(payload);
  if (parsed === null) return null;
  // Empty / partial snapshot means "train has no schedule" — remove the row.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('train_id' in parsed) ||
    typeof (parsed as { train_id: unknown }).train_id !== 'string'
  ) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const train_id = obj.train_id as string;
  if (!('stops' in obj)) return { kind: 'remove', train_id };
  const stops = obj.stops;
  const routeId = obj.route_id;
  const idx = obj.current_stop_index;
  if (
    !Array.isArray(stops) ||
    !stops.every((s): s is string => typeof s === 'string') ||
    typeof routeId !== 'string' ||
    typeof idx !== 'number'
  ) {
    return null;
  }
  return {
    kind: 'set',
    entry: {
      train_id,
      route_id: routeId,
      stops,
      current_stop_index: idx,
    },
  };
}

function decodeJson(payload: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
