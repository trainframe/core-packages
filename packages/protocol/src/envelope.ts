import { type TObject, Type } from '@sinclair/typebox';
import { PROTOCOL_VERSION } from './version.js';

/** v4 UUID */
export const Uuid = Type.String({ format: 'uuid' });

/** ISO 8601 timestamp */
export const Iso8601 = Type.String({ format: 'date-time' });

/** Edge identifier — a directed pair of marker IDs */
export const EdgeRef = Type.Object({
  from_marker_id: Uuid,
  to_marker_id: Uuid,
});

/** Direction of motion or detection along an edge */
export const Direction = Type.Union([Type.Literal('forward'), Type.Literal('reverse')]);

/**
 * Common envelope for every event flowing through the broker.
 *
 * `eventEnvelope(...)` produces a schema for one specific event type. The
 * generic param `T` lets the type checker know what the payload looks like
 * for each event_type.
 */
export const eventEnvelope = <Payload extends TObject>(eventType: string, payload: Payload) =>
  Type.Object({
    event_id: Uuid,
    device_id: Uuid,
    timestamp_device: Iso8601,
    timestamp_server: Type.Optional(Iso8601),
    event_type: Type.Literal(eventType),
    protocol_version: Type.Literal(PROTOCOL_VERSION),
    payload,
  });

/**
 * Common envelope for commands (server → device).
 */
export const commandEnvelope = <Payload extends TObject>(commandType: string, payload: Payload) =>
  Type.Object({
    command_id: Uuid,
    device_id: Uuid,
    timestamp_server: Iso8601,
    command_type: Type.Literal(commandType),
    protocol_version: Type.Literal(PROTOCOL_VERSION),
    payload,
  });
