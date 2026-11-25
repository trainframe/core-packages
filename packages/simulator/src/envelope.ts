import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  CORE_COMMAND_SCHEMAS,
  CORE_EVENT_SCHEMAS,
  type CoreCommand,
  type CoreEvent,
  PROTOCOL_VERSION,
} from '@trainframe/protocol';

/*
 * TypeBox treats string `format` as opt-in: an unregistered format fails
 * validation. The wire shapes use `uuid` / `date-time`, so the edge registers
 * them once (idempotent).
 *
 * The protocol types every identifier field (`command_id`, `device_id`, and every
 * marker/junction/train id) as the shared `Uuid` format, but layouts carry
 * human-readable ids (`M-main-w`, `SWITCH-spur`, `T2`) on the same broker. A
 * UUID-only predicate would drop every command naming such a marker, so the
 * predicate accepts either a canonical UUID or a layout identifier token.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) => UUID_RE.test(value) || ID_TOKEN_RE.test(value));
}
if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (value) => !Number.isNaN(Date.parse(value)));
}

/** The envelope fields a device or platform supplies; the adapter adds the protocol version. */
export interface EventEnvelopeFields {
  readonly event_id: string;
  readonly device_id: string;
  readonly timestamp_device: string;
  readonly event_type: string;
  readonly payload: unknown;
}

/** The envelope fields of a command; the adapter adds the protocol version. */
export interface CommandEnvelopeFields {
  readonly command_id: string;
  readonly device_id: string;
  readonly timestamp_server: string;
  readonly command_type: string;
  readonly payload: unknown;
}

function isKnownEventType(type: unknown): type is keyof typeof CORE_EVENT_SCHEMAS {
  return typeof type === 'string' && Object.hasOwn(CORE_EVENT_SCHEMAS, type);
}

function isKnownCommandType(type: unknown): type is keyof typeof CORE_COMMAND_SCHEMAS {
  return typeof type === 'string' && Object.hasOwn(CORE_COMMAND_SCHEMAS, type);
}

/**
 * Validate an untrusted value against the protocol schema for its `event_type`
 * and return it as a `CoreEvent`, or `undefined` when it is unknown or malformed.
 * The single place in the simulator where an unchecked value becomes a `CoreEvent`.
 */
export function parseCoreEvent(value: unknown): CoreEvent | undefined {
  if (typeof value !== 'object' || value === null || !('event_type' in value)) return undefined;
  if (!isKnownEventType(value.event_type)) return undefined;
  const schema: Parameters<typeof Value.Check>[0] = CORE_EVENT_SCHEMAS[value.event_type];
  if (!Value.Check(schema, value)) return undefined;
  /* Sound: the checked schema is the member of the `CoreEvent` union for this type. */
  return value as CoreEvent;
}

/**
 * Validate an untrusted value against the protocol schema for its `command_type`
 * and return it as a `CoreCommand`, or `undefined` when it is unknown or malformed.
 */
export function parseCoreCommand(value: unknown): CoreCommand | undefined {
  if (typeof value !== 'object' || value === null || !('command_type' in value)) return undefined;
  if (!isKnownCommandType(value.command_type)) return undefined;
  const schema: Parameters<typeof Value.Check>[0] = CORE_COMMAND_SCHEMAS[value.command_type];
  if (!Value.Check(schema, value)) return undefined;
  /* Sound: the checked schema is the member of the `CoreCommand` union for this type. */
  return value as CoreCommand;
}

/**
 * Assemble a `CoreEvent` from envelope fields. A payload that violates the
 * protocol schema for its event type is a programmer error and throws.
 */
export function buildCoreEvent(fields: EventEnvelopeFields): CoreEvent {
  const event = parseCoreEvent({ ...fields, protocol_version: PROTOCOL_VERSION });
  if (event === undefined) {
    throw new Error(`invalid ${fields.event_type} event from ${fields.device_id}`);
  }
  return event;
}

/** Assemble a `CoreCommand` from envelope fields, or `undefined` when it fails validation. */
export function buildCoreCommand(fields: CommandEnvelopeFields): CoreCommand | undefined {
  return parseCoreCommand({ ...fields, protocol_version: PROTOCOL_VERSION });
}
