import { useEffect, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerMessage } from '../broker/client.js';

/**
 * Operator-facing track-learn state, mirrored from the server's retained
 * `railway/state/track_learning/active` topic. The visualiser uses this to
 * render the Learn Track button + status pill — neither the simulator-ui nor
 * any hardware participates here. This is purely a system-level operator
 * surface (ADR-013).
 */
export type TrackLearningStateName =
  | 'idle'
  | 'waiting_for_train'
  | 'driving'
  | 'paused_terminus'
  | 'complete';

export interface TrackLearningState {
  readonly state: TrackLearningStateName;
  readonly train_id?: string;
  readonly markers_visited?: number;
  readonly edges_learned?: number;
  readonly start_marker_id?: string;
  readonly last_marker_id?: string;
}

/** Default before any retained payload arrives — assume idle. */
const DEFAULT_STATE: TrackLearningState = { state: 'idle' };

/**
 * Subscribe to the track-learn state topic and return the latest snapshot.
 * The server publishes this retained, so a fresh subscriber sees the current
 * state on first connect.
 */
export function useTrackLearningState(): TrackLearningState {
  const { client } = useBroker();
  const [state, setState] = useState<TrackLearningState>(DEFAULT_STATE);

  useEffect(() => {
    const handler = (message: BrokerMessage) => {
      const parsed = parsePayload(message.payload);
      if (parsed === null) return;
      setState(parsed);
    };
    return client.subscribe('railway/state/track_learning/active', handler);
  }, [client]);

  return state;
}

function parsePayload(payload: Uint8Array): TrackLearningState | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const state = obj.state;
  if (!isTrackLearningStateName(state)) return null;

  const out: {
    state: TrackLearningStateName;
    train_id?: string;
    markers_visited?: number;
    edges_learned?: number;
    start_marker_id?: string;
    last_marker_id?: string;
  } = { state };
  if (typeof obj.train_id === 'string') out.train_id = obj.train_id;
  if (typeof obj.markers_visited === 'number') out.markers_visited = obj.markers_visited;
  if (typeof obj.edges_learned === 'number') out.edges_learned = obj.edges_learned;
  if (typeof obj.start_marker_id === 'string') out.start_marker_id = obj.start_marker_id;
  if (typeof obj.last_marker_id === 'string') out.last_marker_id = obj.last_marker_id;
  return out;
}

function isTrackLearningStateName(value: unknown): value is TrackLearningStateName {
  return (
    value === 'idle' ||
    value === 'waiting_for_train' ||
    value === 'driving' ||
    value === 'paused_terminus' ||
    value === 'complete'
  );
}
