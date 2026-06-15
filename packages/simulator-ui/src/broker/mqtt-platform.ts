import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
/**
 * The MQTT platform adapter — at the IO / COMPOSITION EDGE, not the device layer.
 *
 * This is the production backing for ADR-031's `PlatformProvider`: it carries a
 * device's events / commands / registration over the project's committed MQTT
 * transport, on top of the existing `BrokerClient` + the `topics.ts` builders. It
 * is a THIN edge adapter the composition root selects when it wires a real device
 * to a real broker — exactly as the composition root would instead pick
 * `inProcessPlatform` for a test or a parent's `platformFor` for a nested zone.
 *
 * It lives here, next to `MqttBrokerClient`, ON PURPOSE: MQTT is one adapter at
 * the IO edge, not a device concern. NOTHING under `devices/` may import this
 * file (a grep enforces it). A device imports only the `PlatformProvider`
 * interface and never learns which backing it got.
 *
 *   - publish(event)  → `railway/events/{event_type}/{deviceId}`, real envelope
 *   - onCommand(h)    → subscribe `railway/commands/{deviceId}`, decode + validate
 *                       the command envelope against the protocol's `CoreCommand`
 *   - register(m)     → a `device_registered` event on `railway/discovery/register`
 */
import {
  CoreCommand,
  type CoreEvent,
  type DeviceManifest,
  PROTOCOL_VERSION,
  topics,
} from '@trainframe/protocol';
import type { CommandHandler, PlatformProvider } from '../devices/platform-provider.js';
import type { BrokerClient } from './client.js';

/* TypeBox treats string `format` as OPT-IN: an unregistered format FAILS
 * validation. The wire shapes use `uuid` / `date-time`, so the edge — where wire
 * validation lives — registers them once. Idempotent: re-registering the same
 * checker is harmless. This belongs at the IO boundary, not in the device layer.
 *
 * The protocol types every IDENTIFIER field (`command_id`, `device_id`, AND every
 * marker/junction/train id like `limit_marker_id`, `junction_marker_id`) as the
 * shared `Uuid` string format. In practice this railway's ids are NOT all v4
 * UUIDs: layouts compiled from pieces or from a physics scene carry human-readable
 * kebab ids (`M-main-w`, `M-yard-throat`, `SWITCH-spur`, `T2`) — the toy-table
 * demo puts exactly these on the same broker. A strict UUID-only predicate would
 * silently DROP every scheduler command whose payload names such a marker, so a
 * scheduler-driven device would never move. The format predicate at this edge
 * therefore accepts EITHER a canonical UUID OR a layout identifier token (the
 * id-safe characters the layouts use). Wire validation still rejects genuinely
 * malformed envelopes (wrong types, missing fields, illegal characters); it just
 * stops mistaking valid marker ids for invalid ones. The protocol schema is
 * unchanged — only the runtime format predicate is widened to match reality. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) => UUID_RE.test(value) || ID_TOKEN_RE.test(value));
}
if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (value) => !Number.isNaN(Date.parse(value)));
}

interface MqttPlatformOptions {
  /** Generates a fresh envelope id. Defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Current ISO-8601 timestamp. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * An MQTT-backed `PlatformProvider` over the existing broker client. The
 * composition root calls this; a device never does.
 */
export function mqttPlatform(
  client: BrokerClient,
  deviceId: string,
  options: MqttPlatformOptions = {},
): PlatformProvider {
  const newId = options.newId ?? defaultNewId;
  const now = options.now ?? defaultNow;

  const encode = (eventType: string, payload: unknown): Uint8Array =>
    textEncoder.encode(
      JSON.stringify({
        event_id: newId(),
        device_id: deviceId,
        timestamp_device: now(),
        event_type: eventType,
        protocol_version: PROTOCOL_VERSION,
        payload,
      }),
    );

  return {
    register(manifest: DeviceManifest): void {
      /* Registration rides a `device_registered` event on the discovery topic —
       *  the capabilities + kind the manifest declares, exactly what core needs
       *  to learn the device exists and what it can do. */
      const payload = {
        capabilities: manifest.capabilities,
        device_kind_hint: manifest.device_kind,
      };
      client.publish(topics.registration, encode('device_registered', payload), { retain: true });
    },

    publish(event: CoreEvent): void {
      /* The event already carries its own envelope shape from the device; we
       *  re-stamp a transport envelope so the wire format matches every other
       *  device on the bus (mirrors `encodeDeviceEvent`). */
      client.publish(
        topics.event(event.event_type, deviceId),
        encode(event.event_type, event.payload),
      );
    },

    onCommand(handler: CommandHandler): () => void {
      return client.subscribe(topics.command(deviceId), (message) => {
        const command = decodeCommand(message.payload);
        if (command !== undefined) handler(command);
      });
    },
  };
}

/**
 * Decode + validate a command envelope off the wire into a typed `CoreCommand`.
 * Returns `undefined` for anything that isn't a structurally-valid core command
 * — the edge never hands a device a malformed message, and never an `any`. The
 * `Value.Check` narrows the parsed JSON to `CoreCommand` soundly.
 */
function decodeCommand(bytes: Uint8Array): CoreCommand | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes));
  } catch {
    return undefined;
  }
  if (!Value.Check(CoreCommand, parsed)) return undefined;
  return parsed;
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Math.floor(Math.random() * 1e12).toString(36)}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}
