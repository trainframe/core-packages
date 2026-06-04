// TODO: extract — see src/view/index.ts for the extraction pattern (LastScannedView).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * Tracks the most recently-scanned entity so the `DevicesPanel` can briefly
 * highlight whichever row corresponds to it. The "entity" is whichever
 * marker/device the operator's last physical scan refers to:
 *
 *   - `tag_observed` → `tag_id` (sim convention: tag_id === marker_id; see
 *     `docs/spec/simulator-v0.1.md` and CLAUDE.md's open question on
 *     tag→marker resolution).
 *   - `tag_assignment` → `target_id` (a freshly-bound tag now refers to a
 *     known marker/vehicle, so highlight that target).
 *
 * Cleared automatically after `holdMs` (default 3s). Re-scanning before the
 * timer fires resets the timer.
 */
export interface UseLastScannedOptions {
  readonly holdMs?: number;
}

export interface UseLastScannedResult {
  readonly entityId: string | null;
  readonly clear: () => void;
}

const DEFAULT_HOLD_MS = 3000;

export function useLastScanned(options: UseLastScannedOptions = {}): UseLastScannedResult {
  const { client } = useBroker();
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  const [entityId, setEntityId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    clearTimer();
    setEntityId(null);
  }, [clearTimer]);

  const flash = useCallback(
    (id: string) => {
      clearTimer();
      setEntityId(id);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setEntityId(null);
      }, holdMs);
    },
    [clearTimer, holdMs],
  );

  useEffect(() => {
    const offObserved = client.subscribe('railway/events/tag_observed/+', (m: BrokerMessage) => {
      const tagId = parseTagObservedTagId(m.payload);
      if (tagId) flash(tagId);
    });
    const offAssignment = client.subscribe(
      'railway/events/tag_assignment/+',
      (m: BrokerMessage) => {
        const targetId = parseTagAssignmentTargetId(m.payload);
        if (targetId) flash(targetId);
      },
    );
    return () => {
      offObserved();
      offAssignment();
    };
  }, [client, flash]);

  // Clear any pending timer when the host component unmounts so the timer
  // can't fire a setState after teardown.
  useEffect(() => clearTimer, [clearTimer]);

  return { entityId, clear };
}

function parseTagObservedTagId(payload: Uint8Array): string | null {
  const inner = unwrapPayload(payload);
  if (!inner) return null;
  if (typeof inner.tag_id !== 'string' || inner.tag_id.length === 0) return null;
  return inner.tag_id;
}

function parseTagAssignmentTargetId(payload: Uint8Array): string | null {
  const inner = unwrapPayload(payload);
  if (!inner) return null;
  if (typeof inner.target_id !== 'string' || inner.target_id.length === 0) return null;
  return inner.target_id;
}

function unwrapPayload(payload: Uint8Array): Record<string, unknown> | null {
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
  // Accept both `{payload: {...}}` (wire envelope) and bare payload shapes.
  const candidate = isObjectWithPayload(raw) ? (raw as { payload: unknown }).payload : raw;
  if (typeof candidate !== 'object' || candidate === null) return null;
  return candidate as Record<string, unknown>;
}

function isObjectWithPayload(value: unknown): value is { payload: unknown } {
  return typeof value === 'object' && value !== null && 'payload' in value;
}
