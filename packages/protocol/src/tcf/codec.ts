/**
 * The Trainframe Compact Frame (TCF) codec — ADR-021.
 *
 * A *pure*, lossless translation between the compact binary TCF frame spoken
 * on the ESP-NOW link and the canonical JSON application envelope spoken on
 * the MQTT bus. This module has no I/O: it neither reads the clock nor
 * generates UUIDs of its own — both are injected, so the codec is fully
 * deterministic (ADR-021 §6/§7; CLAUDE.md determinism rule).
 *
 * Scope of *this* implementation (ADR-021 "Deferred follow-ups"):
 *   - Header codec (13 bytes), the versioned compact-ID registry, envelope
 *     synthesis, and the seq <-> command_id / event_id correlation are the
 *     "framework" this ADR fixes and are implemented here.
 *   - The per-type hand-binarised payload codecs and CBOR are *named deferred
 *     follow-ups* in the ADR ("the byte-level layout of each event's payload
 *     is mechanical follow-up, to land with the firmware-support package").
 *     Until they land, every type's pinned payload codec is the generic one:
 *     UTF-8 JSON of the canonical payload object. `flags.payload_is_cbor`
 *     stays reserved (always 0) exactly as the ADR specifies, ready for CBOR.
 *
 * Frame layout (ADR-021 §2):
 *   byte 0:      version_epoch  (uint8)
 *   byte 1:      type_id        (uint8)
 *   byte 2:      flags          (uint8)  bit0 = is_command; bit1 = payload_is_cbor
 *   bytes 3..6:  device_ref     (uint32, big-endian)
 *   bytes 7..8:  seq            (uint16, big-endian)
 *   bytes 9..12: uptime_ms_lo   (uint32, big-endian)
 *   bytes 13..N: payload bytes
 */

import {
  TCF_REGISTRY_EPOCH,
  commandTypeToId,
  eventTypeToId,
  idToCommandType,
  idToEventType,
} from './registry.js';

/** TCF fixed header length in bytes (ADR-021 §2). */
export const TCF_HEADER_BYTES = 13;

/** ESP-NOW per-frame application payload limit (ADR-021 §Context). */
export const ESP_NOW_MAX_FRAME_BYTES = 250;

/** Maximum payload-region size that still fits one ESP-NOW frame. */
export const TCF_MAX_PAYLOAD_BYTES = ESP_NOW_MAX_FRAME_BYTES - TCF_HEADER_BYTES;

/** Flag bit positions in header byte 2 (ADR-021 §2). */
export const TCF_FLAG_IS_COMMAND = 0b0000_0001;
export const TCF_FLAG_PAYLOAD_IS_CBOR = 0b0000_0010;

/** Maximum values of the fixed-width header fields. */
const MAX_UINT8 = 0xff;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffff_ffff;

/**
 * Decoded view of a TCF frame's header and (JSON) payload, before envelope
 * synthesis. Useful for inspection and for the size/round-trip tests.
 */
export interface TcfFrame {
  readonly versionEpoch: number;
  readonly typeId: number;
  readonly isCommand: boolean;
  readonly payloadIsCbor: boolean;
  readonly deviceRef: number;
  readonly seq: number;
  readonly uptimeMs: number;
  /** Canonical payload object, as the bridge would place in the envelope. */
  readonly payload: unknown;
}

/**
 * A canonical JSON *event* envelope, as published on the MQTT bus. Mirrors
 * `eventEnvelope(...)` in envelope.ts (kept structural to avoid coupling the
 * codec to a specific generated schema).
 */
export interface EventEnvelope {
  readonly event_id: string;
  readonly device_id: string;
  readonly timestamp_device: string;
  readonly event_type: string;
  readonly protocol_version: string;
  readonly payload: unknown;
}

/**
 * A canonical JSON *command* envelope, as published on the MQTT bus. Mirrors
 * `commandEnvelope(...)` in envelope.ts.
 */
export interface CommandEnvelope {
  readonly command_id: string;
  readonly device_id: string;
  readonly timestamp_server: string;
  readonly command_type: string;
  readonly protocol_version: string;
  readonly payload: unknown;
}

/**
 * Per-device correlation a real bridge holds (ADR-021 §5/§6). The codec is
 * pure: it never invents this state, it reads and writes the maps it is
 * handed. `decode` populates them; `encode` reads them so the round-trip is
 * byte-stable. A bridge would persist one context per paired fleet.
 *
 * - `deviceRefToId` / `deviceIdToRef`: device_ref <-> canonical device_id UUID.
 * - `idToSeqUptime`: envelope event_id/command_id -> the originating frame's
 *   (deviceRef, seq, uptimeMs), so the inverse can rebuild those header bytes
 *   that the JSON envelope does not itself carry.
 */
export interface BridgeContext {
  readonly deviceRefToId: Map<number, string>;
  readonly deviceIdToRef: Map<string, number>;
  readonly idToSeqUptime: Map<string, { deviceRef: number; seq: number; uptimeMs: number }>;
}

/** Create an empty {@link BridgeContext}. */
export function createBridgeContext(): BridgeContext {
  return {
    deviceRefToId: new Map(),
    deviceIdToRef: new Map(),
    idToSeqUptime: new Map(),
  };
}

/** Hooks the codec needs but must not perform itself (determinism rule). */
export interface CodecDeps {
  /** Returns a fresh UUID-shaped envelope id (event_id / command_id). */
  readonly newId: () => string;
  /** Returns the current wall-clock timestamp as ISO-8601. */
  readonly now: () => string;
  /** Protocol version stamped on synthesised envelopes. */
  readonly protocolVersion: string;
}

/** Result of expanding a frame: an event or a command envelope. */
export type DecodeResult =
  | { readonly kind: 'event'; readonly envelope: EventEnvelope }
  | { readonly kind: 'command'; readonly envelope: CommandEnvelope };

function assertUint(value: number, max: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`TCF ${field} must be an integer in 0..${max}, got ${value}`);
  }
}

/**
 * Read the raw header + JSON payload of a TCF frame without synthesising an
 * envelope. Throws only on a structurally invalid frame (too short, payload
 * not valid UTF-8 JSON) — a genuine programmer/wire error.
 */
export function readFrame(bytes: Uint8Array): TcfFrame {
  if (bytes.length < TCF_HEADER_BYTES) {
    throw new RangeError(
      `TCF frame too short: ${bytes.length} bytes, need at least ${TCF_HEADER_BYTES}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionEpoch = view.getUint8(0);
  const typeId = view.getUint8(1);
  const flags = view.getUint8(2);
  const deviceRef = view.getUint32(3, false);
  const seq = view.getUint16(7, false);
  const uptimeMs = view.getUint32(9, false);

  const payloadBytes = bytes.subarray(TCF_HEADER_BYTES);
  const payload = payloadBytes.length === 0 ? {} : decodeJsonPayload(payloadBytes);

  return {
    versionEpoch,
    typeId,
    isCommand: (flags & TCF_FLAG_IS_COMMAND) !== 0,
    payloadIsCbor: (flags & TCF_FLAG_PAYLOAD_IS_CBOR) !== 0,
    deviceRef,
    seq,
    uptimeMs,
    payload,
  };
}

function decodeJsonPayload(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

/**
 * Expand an inbound TCF frame into the canonical JSON envelope, exactly as
 * the bridge would publish it on MQTT (ADR-021 §1, §5–§7).
 *
 * Synthesises `event_id`/`command_id`, the full `device_id`, the wall-clock
 * timestamp, and `protocol_version`. Records the (deviceRef, seq, uptimeMs)
 * against the synthesised id in `ctx` so {@link encode} can rebuild a
 * byte-identical frame.
 *
 * Default-safe behaviour (ADR-021 §3): an unknown `type_id` for the frame's
 * direction is expanded to an `anomaly` event rather than guessed.
 */
export function decode(bytes: Uint8Array, ctx: BridgeContext, deps: CodecDeps): DecodeResult {
  const frame = readFrame(bytes);

  const deviceId = resolveDeviceId(frame.deviceRef, ctx);

  if (frame.isCommand) {
    return decodeCommand(frame, deviceId, ctx, deps);
  }
  return decodeEvent(frame, deviceId, ctx, deps);
}

function resolveDeviceId(deviceRef: number, ctx: BridgeContext): string {
  const existing = ctx.deviceRefToId.get(deviceRef);
  if (existing !== undefined) return existing;
  /*
   * Unknown device_ref. A real bridge assigns the device_id <-> device_ref
   * mapping at pairing time; absent that, derive a stable synthetic UUID-shaped
   * id from the ref so the codec stays pure and the mapping is self-consistent.
   */
  const synthesized = syntheticDeviceId(deviceRef);
  ctx.deviceRefToId.set(deviceRef, synthesized);
  ctx.deviceIdToRef.set(synthesized, deviceRef);
  return synthesized;
}

/** Deterministic UUID-shaped id derived from a device_ref (no I/O). */
function syntheticDeviceId(deviceRef: number): string {
  const hex = deviceRef.toString(16).padStart(8, '0');
  return `00000000-0000-4000-8000-0000${hex}`;
}

function rememberCorrelation(id: string, frame: TcfFrame, ctx: BridgeContext): void {
  ctx.idToSeqUptime.set(id, {
    deviceRef: frame.deviceRef,
    seq: frame.seq,
    uptimeMs: frame.uptimeMs,
  });
}

function decodeEvent(
  frame: TcfFrame,
  deviceId: string,
  ctx: BridgeContext,
  deps: CodecDeps,
): DecodeResult {
  const eventType = idToEventType(frame.typeId);
  const eventId = deps.newId();
  rememberCorrelation(eventId, frame, ctx);

  if (eventType === undefined) {
    /* Unknown type_id — default-safe anomaly (ADR-021 §3). */
    return {
      kind: 'event',
      envelope: {
        event_id: eventId,
        device_id: deviceId,
        timestamp_device: deps.now(),
        event_type: 'anomaly',
        protocol_version: deps.protocolVersion,
        payload: {
          severity: 'warning',
          description: `Unknown TCF event type_id ${frame.typeId} at epoch ${frame.versionEpoch}`,
          context: { type_id: frame.typeId, version_epoch: frame.versionEpoch },
        },
      },
    };
  }

  return {
    kind: 'event',
    envelope: {
      event_id: eventId,
      device_id: deviceId,
      timestamp_device: deps.now(),
      event_type: eventType,
      protocol_version: deps.protocolVersion,
      payload: frame.payload,
    },
  };
}

function decodeCommand(
  frame: TcfFrame,
  deviceId: string,
  ctx: BridgeContext,
  deps: CodecDeps,
): DecodeResult {
  const commandType = idToCommandType(frame.typeId);
  const commandId = deps.newId();
  rememberCorrelation(commandId, frame, ctx);

  if (commandType === undefined) {
    /*
     * Unknown command type_id. Commands have no anomaly counterpart, so
     * surface the same default-safe anomaly *event* — a bridge would publish
     * it rather than enact a guessed command.
     */
    return {
      kind: 'event',
      envelope: {
        event_id: commandId,
        device_id: deviceId,
        timestamp_device: deps.now(),
        event_type: 'anomaly',
        protocol_version: deps.protocolVersion,
        payload: {
          severity: 'warning',
          description: `Unknown TCF command type_id ${frame.typeId} at epoch ${frame.versionEpoch}`,
          context: { type_id: frame.typeId, version_epoch: frame.versionEpoch },
        },
      },
    };
  }

  return {
    kind: 'command',
    envelope: {
      command_id: commandId,
      device_id: deviceId,
      timestamp_server: deps.now(),
      command_type: commandType,
      protocol_version: deps.protocolVersion,
      payload: frame.payload,
    },
  };
}

/** Fields the caller may override when compacting; otherwise read from ctx. */
export interface EncodeOverrides {
  readonly deviceRef?: number;
  readonly seq?: number;
  readonly uptimeMs?: number;
  readonly versionEpoch?: number;
}

/**
 * Compact a canonical JSON event envelope back into a TCF frame (ADR-021 §1).
 * Looks up the (deviceRef, seq, uptimeMs) that {@link decode} stashed against
 * `event_id`, falling back to the device_id->ref map and explicit overrides.
 * Throws on an event type with no compact ID — a programmer error (the
 * registry must cover every published core type; the anti-drift test enforces
 * this).
 */
export function encodeEvent(
  envelope: EventEnvelope,
  ctx: BridgeContext,
  overrides: EncodeOverrides = {},
): Uint8Array {
  const typeId = requireEventId(envelope.event_type);
  const corr = resolveCorrelation(envelope.event_id, envelope.device_id, ctx, overrides);
  return writeFrame({
    versionEpoch: overrides.versionEpoch ?? TCF_REGISTRY_EPOCH,
    typeId,
    flags: 0,
    deviceRef: corr.deviceRef,
    seq: corr.seq,
    uptimeMs: corr.uptimeMs,
    payload: envelope.payload,
  });
}

/**
 * Compact a canonical JSON command envelope back into a TCF frame. Maps the
 * inbound command's `command_id` to the outbound frame's `seq` (ADR-021 §6).
 */
export function encodeCommand(
  envelope: CommandEnvelope,
  ctx: BridgeContext,
  overrides: EncodeOverrides = {},
): Uint8Array {
  const typeId = requireCommandId(envelope.command_type);
  const corr = resolveCorrelation(envelope.command_id, envelope.device_id, ctx, overrides);
  return writeFrame({
    versionEpoch: overrides.versionEpoch ?? TCF_REGISTRY_EPOCH,
    typeId,
    flags: TCF_FLAG_IS_COMMAND,
    deviceRef: corr.deviceRef,
    seq: corr.seq,
    uptimeMs: corr.uptimeMs,
    payload: envelope.payload,
  });
}

/*
 * Registry lookups that throw on a miss. "Throw on miss" is an encode-direction
 * policy, not a registry fact: the registry itself returns `undefined` so decode
 * can choose the default-safe path. The anti-drift test guarantees every
 * published core type has an ID, so a miss here is a genuine programmer error.
 */
function requireEventId(eventType: string): number {
  const id = eventTypeToId(eventType);
  if (id === undefined) {
    throw new RangeError(`No TCF compact ID for event type "${eventType}"`);
  }
  return id;
}

function requireCommandId(commandType: string): number {
  const id = commandTypeToId(commandType);
  if (id === undefined) {
    throw new RangeError(`No TCF compact ID for command type "${commandType}"`);
  }
  return id;
}

function resolveCorrelation(
  envelopeId: string,
  deviceId: string,
  ctx: BridgeContext,
  overrides: EncodeOverrides,
): { deviceRef: number; seq: number; uptimeMs: number } {
  const stashed = ctx.idToSeqUptime.get(envelopeId);
  const deviceRef =
    overrides.deviceRef ?? stashed?.deviceRef ?? ctx.deviceIdToRef.get(deviceId) ?? 0;
  const seq = overrides.seq ?? stashed?.seq ?? 0;
  const uptimeMs = overrides.uptimeMs ?? stashed?.uptimeMs ?? 0;
  return { deviceRef, seq, uptimeMs };
}

interface FrameFields {
  readonly versionEpoch: number;
  readonly typeId: number;
  readonly flags: number;
  readonly deviceRef: number;
  readonly seq: number;
  readonly uptimeMs: number;
  readonly payload: unknown;
}

function writeFrame(fields: FrameFields): Uint8Array {
  assertUint(fields.versionEpoch, MAX_UINT8, 'version_epoch');
  assertUint(fields.typeId, MAX_UINT8, 'type_id');
  assertUint(fields.flags, MAX_UINT8, 'flags');
  assertUint(fields.deviceRef, MAX_UINT32, 'device_ref');
  assertUint(fields.seq, MAX_UINT16, 'seq');
  assertUint(fields.uptimeMs, MAX_UINT32, 'uptime_ms');

  const payloadBytes = encodeJsonPayload(fields.payload);
  if (payloadBytes.length > TCF_MAX_PAYLOAD_BYTES) {
    throw new RangeError(
      `TCF payload ${payloadBytes.length} bytes exceeds ${TCF_MAX_PAYLOAD_BYTES} (frame limit ${ESP_NOW_MAX_FRAME_BYTES}); needs a fixed per-type codec or out-of-band path (ADR-021 deferred follow-ups)`,
    );
  }

  const frame = new Uint8Array(TCF_HEADER_BYTES + payloadBytes.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, fields.versionEpoch);
  view.setUint8(1, fields.typeId);
  view.setUint8(2, fields.flags);
  view.setUint32(3, fields.deviceRef, false);
  view.setUint16(7, fields.seq, false);
  view.setUint32(9, fields.uptimeMs, false);
  frame.set(payloadBytes, TCF_HEADER_BYTES);
  return frame;
}

/**
 * Encode a payload object to the frame's payload region. Empty objects encode
 * to zero bytes (saving the `{}` overhead); everything else is UTF-8 JSON.
 * The generic codec until per-type codecs land (ADR-021 §4 deferred).
 */
function encodeJsonPayload(payload: unknown): Uint8Array {
  if (isEmptyObject(payload)) return new Uint8Array(0);
  return new TextEncoder().encode(JSON.stringify(payload));
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
