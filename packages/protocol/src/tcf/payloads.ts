/**
 * TCF per-type compact payload codecs — ADR-021 §4.
 *
 * For the hot, UUID-heavy core types, the generic UTF-8-JSON payload carrier
 * overflows the 250-byte ESP-NOW frame (a single `clearance_request` is three
 * full 36-char UUID strings — ~253 bytes once the header is added). This module
 * pins a *fixed-field-order* binary codec per such type that packs each 36-char
 * UUID string to its 16 raw bytes, enums to one byte, and booleans to one byte,
 * so the frame fits and round-trips losslessly back to the canonical JSON
 * payload object.
 *
 * Design (CLAUDE.md zero-`any`):
 *   - The codec table is uniform over `unknown` — each {@link PayloadCodec} is
 *     the single sound coercion point (the `wrap()` analog from capability.ts).
 *     Narrowing happens *inside* each codec via explicit guards that throw on a
 *     shape mismatch (a genuine programmer/wire error, the only throw the
 *     determinism rule permits). No generics on the table, no `any`, no casts.
 *   - Codec selection is a pure function of `(isCommand, typeId)`. A type with
 *     no entry falls back to the generic JSON carrier in codec.ts.
 *   - UUID packing is stateless 16-byte fixed-width (parse the canonical hex,
 *     re-emit lowercase with dashes) — no per-payload handle table, so no
 *     cross-message global state is introduced (ADR-021 §5 keeps the *header*
 *     device_ref handle; payload refs need none given the byte budget).
 *
 * This module is pure: no I/O, no clock, no RNG.
 */

import type { CompactCommandType, CompactEventType } from './registry.js';

/**
 * A reversible binary codec for one type's canonical JSON payload object.
 * `encode ∘ decode` and `decode ∘ encode` are the identity on well-formed
 * inputs. Both throw a `TypeError`/`RangeError` on a structurally invalid
 * payload or byte string — a programmer/wire error, never a control-flow path.
 */
export interface PayloadCodec {
  readonly encode: (payload: unknown) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => unknown;
}

const UUID_BYTES = 16;

/* ---------- small reversible field primitives ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError('TCF per-type codec expected an object payload');
  }
  return value;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new TypeError(`TCF payload field "${key}" must be a string`);
  }
  return value;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    throw new TypeError(`TCF payload field "${key}" must be a boolean`);
  }
  return value;
}

/**
 * Pack a canonical v4-UUID string (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) into
 * exactly 16 bytes. Throws on a non-UUID string — only fields the schema types
 * as `Uuid` are routed here, so a non-UUID is a programmer error.
 */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== UUID_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError(`TCF: not a UUID: "${uuid}"`);
  }
  const out = new Uint8Array(UUID_BYTES);
  for (let i = 0; i < UUID_BYTES; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    out[i] = byte;
  }
  return out;
}

/** Format 16 bytes back to a canonical lowercase UUID string. */
function bytesToUuid(bytes: Uint8Array, offset: number): string {
  const hex: string[] = [];
  for (let i = 0; i < UUID_BYTES; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) {
      throw new RangeError('TCF: ran out of bytes decoding a UUID');
    }
    hex.push(byte.toString(16).padStart(2, '0'));
  }
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A directed edge: a pair of marker UUIDs. */
interface Edge {
  readonly from_marker_id: string;
  readonly to_marker_id: string;
}

function requireEdge(value: unknown): Edge {
  const obj = requireRecord(value);
  return {
    from_marker_id: requireString(obj, 'from_marker_id'),
    to_marker_id: requireString(obj, 'to_marker_id'),
  };
}

/**
 * A minimal forward-only byte writer. Avoids `DataView` index gymnastics for
 * the variable-shape payloads; every append is bounds-safe by construction.
 */
class ByteWriter {
  private readonly chunks: Uint8Array[] = [];

  u8(value: number): void {
    this.chunks.push(Uint8Array.of(value & 0xff));
  }

  uuid(uuid: string): void {
    this.chunks.push(uuidToBytes(uuid));
  }

  edge(edge: Edge): void {
    this.uuid(edge.from_marker_id);
    this.uuid(edge.to_marker_id);
  }

  finish(): Uint8Array {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** A forward-only byte reader that throws if a read runs past the end. */
class ByteReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u8(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) {
      throw new RangeError('TCF: ran out of bytes decoding a u8');
    }
    this.offset += 1;
    return value;
  }

  uuid(): string {
    if (this.offset + UUID_BYTES > this.bytes.length) {
      throw new RangeError('TCF: ran out of bytes decoding a UUID');
    }
    const uuid = bytesToUuid(this.bytes, this.offset);
    this.offset += UUID_BYTES;
    return uuid;
  }

  edge(): Edge {
    return { from_marker_id: this.uuid(), to_marker_id: this.uuid() };
  }

  /** True once every byte has been consumed — a lossless-decode invariant. */
  atEnd(): boolean {
    return this.offset === this.bytes.length;
  }
}

/* ---------- enum <-> byte tables (reversible, append-only) ---------- */

/** Direction enum. Index === byte value. */
const DIRECTIONS = ['forward', 'reverse'] as const;

function directionToByte(direction: string): number {
  const index = DIRECTIONS.indexOf(direction as (typeof DIRECTIONS)[number]);
  if (index < 0) throw new TypeError(`TCF: unknown direction "${direction}"`);
  return index;
}

function byteToDirection(byte: number): (typeof DIRECTIONS)[number] {
  const direction = DIRECTIONS[byte];
  if (direction === undefined) throw new RangeError(`TCF: unknown direction byte ${byte}`);
  return direction;
}

/* ---------- per-type codecs ---------- */

/**
 * `marker_traversed` (ADR-021 §4 hot type). Layout:
 *   train_id (16) · marker_id (16) · direction (1) · in_discovery_mode (1) ·
 *   has_inferred_edge (1) · [inferred_edge (32) if present]
 *
 * The optional `inferred_edge` carries two more UUIDs; with it present the
 * generic JSON carrier overflows 250 bytes, which is what this codec fixes.
 */
const markerTraversedCodec: PayloadCodec = {
  encode(payload) {
    const obj = requireRecord(payload);
    const writer = new ByteWriter();
    writer.uuid(requireString(obj, 'train_id'));
    writer.uuid(requireString(obj, 'marker_id'));
    writer.u8(directionToByte(requireString(obj, 'direction')));
    writer.u8(requireBoolean(obj, 'in_discovery_mode') ? 1 : 0);
    const inferred = obj.inferred_edge;
    if (inferred === undefined) {
      writer.u8(0);
    } else {
      writer.u8(1);
      writer.edge(requireEdge(inferred));
    }
    return writer.finish();
  },
  decode(bytes) {
    const reader = new ByteReader(bytes);
    const train_id = reader.uuid();
    const marker_id = reader.uuid();
    const direction = byteToDirection(reader.u8());
    const in_discovery_mode = reader.u8() === 1;
    const hasInferred = reader.u8() === 1;
    const inferredEdge = hasInferred ? reader.edge() : undefined;
    requireFullyConsumed(reader);
    return {
      train_id,
      marker_id,
      direction,
      in_discovery_mode,
      ...(inferredEdge === undefined ? {} : { inferred_edge: inferredEdge }),
    };
  },
};

/**
 * `clearance_request` (ADR-021 §4 hot type — the one that overflows today).
 * Layout: train_id (16) · current_limit_marker_id (16) · next_edge (32) = 64 B.
 */
const clearanceRequestCodec: PayloadCodec = {
  encode(payload) {
    const obj = requireRecord(payload);
    const writer = new ByteWriter();
    writer.uuid(requireString(obj, 'train_id'));
    writer.uuid(requireString(obj, 'current_limit_marker_id'));
    writer.edge(requireEdge(obj.next_edge));
    return writer.finish();
  },
  decode(bytes) {
    const reader = new ByteReader(bytes);
    const train_id = reader.uuid();
    const current_limit_marker_id = reader.uuid();
    const next_edge = reader.edge();
    requireFullyConsumed(reader);
    return { train_id, current_limit_marker_id, next_edge };
  },
};

/**
 * `clearance_granted`. Layout:
 *   train_id (16) · new_limit_marker_id (16) · edge_count (1) · edges (32·N)
 * Exercises an array field (empty and non-empty both round-trip).
 */
const clearanceGrantedCodec: PayloadCodec = {
  encode(payload) {
    const obj = requireRecord(payload);
    const writer = new ByteWriter();
    writer.uuid(requireString(obj, 'train_id'));
    writer.uuid(requireString(obj, 'new_limit_marker_id'));
    const edges = obj.edges_newly_cleared;
    if (!Array.isArray(edges)) {
      throw new TypeError('TCF clearance_granted: edges_newly_cleared must be an array');
    }
    if (edges.length > 0xff) {
      throw new RangeError('TCF clearance_granted: too many edges for one frame');
    }
    writer.u8(edges.length);
    for (const edge of edges) writer.edge(requireEdge(edge));
    return writer.finish();
  },
  decode(bytes) {
    const reader = new ByteReader(bytes);
    const train_id = reader.uuid();
    const new_limit_marker_id = reader.uuid();
    const count = reader.u8();
    const edges_newly_cleared: Edge[] = [];
    for (let i = 0; i < count; i += 1) edges_newly_cleared.push(reader.edge());
    requireFullyConsumed(reader);
    return { train_id, new_limit_marker_id, edges_newly_cleared };
  },
};

/**
 * `grant_clearance` command (the per-type command exemplar — proves the
 * command direction also fits a fixed codec). Layout:
 *   limit_marker_id (16) · has_reason (1) · [reason (len-prefixed UTF-8)]
 * `reason` is `Type.String` (free text), so it is length-prefixed UTF-8, NOT
 * UUID-packed.
 */
const grantClearanceCodec: PayloadCodec = {
  encode(payload) {
    const obj = requireRecord(payload);
    const writer = new ByteWriter();
    writer.uuid(requireString(obj, 'limit_marker_id'));
    const reason = obj.reason;
    if (reason === undefined) {
      writer.u8(0);
    } else {
      if (typeof reason !== 'string') {
        throw new TypeError('TCF grant_clearance: reason must be a string');
      }
      const reasonBytes = new TextEncoder().encode(reason);
      if (reasonBytes.length > 0xff) {
        throw new RangeError('TCF grant_clearance: reason too long for one byte length prefix');
      }
      writer.u8(1);
      writer.u8(reasonBytes.length);
      for (const byte of reasonBytes) writer.u8(byte);
    }
    return writer.finish();
  },
  decode(bytes) {
    const reader = new ByteReader(bytes);
    const limit_marker_id = reader.uuid();
    const hasReason = reader.u8() === 1;
    let reason: string | undefined;
    if (hasReason) {
      const length = reader.u8();
      const reasonBytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) reasonBytes[i] = reader.u8();
      reason = new TextDecoder('utf-8', { fatal: true }).decode(reasonBytes);
    }
    requireFullyConsumed(reader);
    return {
      limit_marker_id,
      ...(reason === undefined ? {} : { reason }),
    };
  },
};

function requireFullyConsumed(reader: ByteReader): void {
  if (!reader.atEnd()) {
    throw new RangeError('TCF per-type codec: trailing bytes after decode (frame corrupt)');
  }
}

/**
 * Event types with a pinned per-type codec. Every other event type falls back
 * to the generic JSON carrier in codec.ts (ADR-021 §4). Keys are
 * `CompactEventType` so a renamed/removed type fails to compile here.
 */
const EVENT_PAYLOAD_CODECS: Partial<Record<CompactEventType, PayloadCodec>> = {
  marker_traversed: markerTraversedCodec,
  clearance_request: clearanceRequestCodec,
  clearance_granted: clearanceGrantedCodec,
};

/** Command types with a pinned per-type codec. */
const COMMAND_PAYLOAD_CODECS: Partial<Record<CompactCommandType, PayloadCodec>> = {
  grant_clearance: grantClearanceCodec,
};

/**
 * The per-type codec for an event type, or `undefined` to use the generic
 * JSON carrier. Pure function of the type alone (ADR-021 §4).
 */
export function eventPayloadCodec(eventType: string): PayloadCodec | undefined {
  return EVENT_PAYLOAD_CODECS[eventType as CompactEventType];
}

/** The per-type codec for a command type, or `undefined` for the generic carrier. */
export function commandPayloadCodec(commandType: string): PayloadCodec | undefined {
  return COMMAND_PAYLOAD_CODECS[commandType as CompactCommandType];
}
