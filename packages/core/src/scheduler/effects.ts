import { type TrainState, occupiedEdges } from './train-state.js';
import type { EdgeRef } from './types.js';

/**
 * The scheduler is pure: it consumes events and emits Effects. Effects describe
 * what the platform should *do*. The platform layer (server, simulator, test
 * harness) is responsible for actually performing them.
 *
 * This separation means the scheduler is fully testable without I/O.
 */
export type SchedulerEffect =
  | {
      kind: 'send_command';
      device_id: string;
      command_type: string;
      payload: unknown;
    }
  | {
      kind: 'publish_event';
      event_type: string;
      payload: unknown;
    }
  | {
      kind: 'update_state_snapshot';
      entity_type: string;
      entity_id: string;
      state: unknown;
    };

/** Every event handler returns a list of effects to perform. */
export type EffectList = ReadonlyArray<SchedulerEffect>;

/** Convenience constructors. */
export const effects = {
  sendCommand: (deviceId: string, commandType: string, payload: unknown): SchedulerEffect => ({
    kind: 'send_command',
    device_id: deviceId,
    command_type: commandType,
    payload,
  }),
  publishEvent: (eventType: string, payload: unknown): SchedulerEffect => ({
    kind: 'publish_event',
    event_type: eventType,
    payload,
  }),
  updateState: (entityType: string, entityId: string, state: unknown): SchedulerEffect => ({
    kind: 'update_state_snapshot',
    entity_type: entityType,
    entity_id: entityId,
    state,
  }),
} as const;

export const grantClearancePayload = (
  newLimitMarkerId: string,
  edgesNewlyCleared: ReadonlyArray<EdgeRef>,
) => ({
  limit_marker_id: newLimitMarkerId,
  reason: 'route extension',
  edges_newly_cleared: edgesNewlyCleared,
});

/**
 * The retained-state snapshot of which edges a train currently holds, published
 * every time its `cleared_edges` changes (grant, release, revoke, disconnect).
 * A standing block is held too, so it is listed with them.
 * An empty array clears the visual: the visualiser drops the train's overlay
 * entries when it sees [].
 *
 * A hold the scheduler owns (ADR-019, currently only `'unknown_topology'`) is
 * surfaced here as `block_reason`, not on the train-emitted `train_status`. The
 * field is absent, never `undefined`, when the train is not so held.
 */
export function clearanceStateEffect(train: TrainState): SchedulerEffect {
  const base = {
    train_id: train.train_id,
    cleared_edges: occupiedEdges(train),
  };
  return effects.updateState(
    'clearance',
    train.train_id,
    train.block_reason === undefined ? base : { ...base, block_reason: train.block_reason },
  );
}
