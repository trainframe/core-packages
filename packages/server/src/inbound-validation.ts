import { FormatRegistry, type TObject, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CORE_EVENT_SCHEMAS } from '@trainframe/protocol';

/*
 * The protocol's `Uuid` format names every id field, but the railway's ids are
 * not all v4 UUIDs: layouts compiled from pieces or a physics scene use
 * readable tokens (`M-main-w`, `T2`). The predicate accepts either, exactly as
 * the simulator's wire edge does, so a valid marker id is never mistaken for a
 * malformed one. Registration is skipped if another module already set it.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) => UUID_RE.test(value) || ID_TOKEN_RE.test(value));
}
if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (value) => !Number.isNaN(Date.parse(value)));
}

const EVENT_SCHEMAS: Readonly<Record<string, TObject>> = CORE_EVENT_SCHEMAS;

const PAYLOAD_SCHEMAS: ReadonlyMap<string, TSchema> = new Map(
  Object.entries(EVENT_SCHEMAS).flatMap(([eventType, envelope]) => {
    const payload = envelope.properties.payload;
    return payload === undefined ? [] : [[eventType, payload] as const];
  }),
);

/**
 * Check an inbound event's payload against its core protocol schema before the
 * scheduler sees it. Returns a short description of the first problem, or
 * `undefined` when the payload is valid or the event type is not a core one
 * (capability-specific events are the capability's to interpret).
 */
export function coreEventPayloadProblem(eventType: string, payload: unknown): string | undefined {
  const payloadSchema = PAYLOAD_SCHEMAS.get(eventType);
  if (payloadSchema === undefined) return undefined;
  const first = Value.Errors(payloadSchema, payload).First();
  if (first === undefined) return undefined;
  return `${first.path || '(payload)'}: ${first.message}`;
}
