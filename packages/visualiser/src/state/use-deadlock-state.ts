// TODO: extract — see src/view/index.ts for the extraction pattern (DeadlockStateView).
import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * The trains currently part of a waits-for cycle, as reported by the
 * scheduler. Empty array (or undefined) means no active deadlock. Rebuilt
 * from retained `railway/state/deadlock/active` messages.
 */
export type DeadlockState = ReadonlyArray<string>;

interface DeadlockPayload {
  readonly trains: ReadonlyArray<string>;
}

/**
 * Subscribe to `railway/state/deadlock/active` and surface the current
 * deadlock-participant list. The scheduler emits this whenever its
 * waits-for cycle detection finds (or no longer finds) a cycle — see
 * `Scheduler.maybeEmitDeadlockState`. The retained flag means fresh
 * subscribers see the current state on first connect.
 */
export function useDeadlockState(): DeadlockState {
  const { client } = useBroker();
  const [trains, setTrains] = useState<ReadonlyArray<string>>([]);

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parseDeadlockMessage(message.payload);
      if (!parsed) return;
      setTrains(parsed.trains);
    };
    return client.subscribe('railway/state/deadlock/active', handler);
  }, [client]);

  return trains;
}

function parseDeadlockMessage(payload: Uint8Array): DeadlockPayload | null {
  const parsed = decodeJson(payload);
  if (parsed === null) return null;
  if (parsed === 'empty') return { trains: [] };
  // The scheduler emits `update_state_snapshot` effects which the server
  // routes verbatim — but the payload can be the bare state object (the
  // shape produced by `effects.updateState`'s `state` field) or wrapped in
  // an envelope. Accept both.
  const bare = extractTrainsList(parsed);
  if (bare) return bare;
  const enveloped = extractTrainsList((parsed as { state?: unknown }).state);
  if (enveloped) return enveloped;
  return null;
}

function decodeJson(payload: Uint8Array): unknown | 'empty' | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  if (text.length === 0) return 'empty';
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractTrainsList(value: unknown): DeadlockPayload | null {
  if (!value || typeof value !== 'object' || !('trains' in value)) return null;
  const trains = (value as { trains: unknown }).trains;
  if (!Array.isArray(trains)) return null;
  if (!trains.every((t): t is string => typeof t === 'string')) return null;
  return { trains };
}
