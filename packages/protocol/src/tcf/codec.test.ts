import { describe, expect, it } from 'vitest';
import {
  type CodecDeps,
  type CommandEnvelope,
  ESP_NOW_MAX_FRAME_BYTES,
  type EventEnvelope,
  TCF_FLAG_IS_COMMAND,
  TCF_FLAG_PAYLOAD_IS_CBOR,
  TCF_HEADER_BYTES,
  createBridgeContext,
  decode,
  encodeCommand,
  encodeEvent,
  readFrame,
} from './codec.js';
import { commandPayloadCodec, eventPayloadCodec } from './payloads.js';
import {
  COMMAND_TYPE_ORDER,
  EVENT_TYPE_ORDER,
  TCF_REGISTRY_EPOCH,
  commandTypeToId,
} from './registry.js';

/* Deterministic deps — no Date.now / randomUUID anywhere (CLAUDE.md). */
function makeDeps(): CodecDeps {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      const hex = counter.toString(16).padStart(12, '0');
      return `11111111-1111-4111-8111-${hex}`;
    },
    now: () => '2026-06-09T00:00:00.000Z',
    protocolVersion: '0.4.0',
  };
}

const DEVICE_REF = 0x0a0b0c0d;
const DEVICE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A representative, single-frame payload for each event type (ADR-021 §4). */
const EVENT_PAYLOADS: Record<string, unknown> = {
  device_registered: { capabilities: ['core.controls_motion'], device_kind_hint: 'loco' },
  tag_observed: { tag_id: 'M3', direction: 'forward' },
  marker_traversed: {
    train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
    direction: 'forward',
    in_discovery_mode: false,
  },
  vehicle_identified: { vehicle_id: 'V1', context_device_id: 'D1' },
  train_status: {
    train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    speed_normalised: 0.5,
  },
  clearance_request: {
    train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    current_limit_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
    next_edge: {
      from_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      to_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
    },
  },
  clearance_granted: {
    train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    new_limit_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
    edges_newly_cleared: [],
  },
  clearance_revoked: {
    train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    reason: 'block_occupied',
    immediate: true,
  },
  gate_state_changed: {
    marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
    state: 'withholding',
  },
  switch_state_changed: {
    junction_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
    position: 'main',
    confirmed: true,
  },
  aspect_changed: { current_aspect: 'green' },
  tag_assignment: { tag_id: 'M3', assigned_kind: 'marker', target_id: 'M3' },
  anomaly: { severity: 'warning', description: 'short' },
};

/** A representative payload for each command type. */
const COMMAND_PAYLOADS: Record<string, unknown> = {
  assign_route: {
    route_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    edges: [
      {
        from_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
        to_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      },
    ],
  },
  grant_clearance: { limit_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003' },
  revoke_clearance: { reason: 'fault', immediate: true },
  begin_exploration: {},
  set_target_speed: { speed_normalised: 0.7 },
  emergency_stop: {},
  set_switch_position: {
    junction_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
    position: 'branch',
  },
  set_aspect: { aspect: 'red' },
  hold_gate: { marker_id: 'aaaaaaaa-0000-4000-8000-000000000002' },
  release_gate: { marker_id: 'aaaaaaaa-0000-4000-8000-000000000002' },
  assign_tag: { tag_id: 'M3', assigned_kind: 'marker', target_id: 'M3' },
};

function pairedContext() {
  const ctx = createBridgeContext();
  ctx.deviceRefToId.set(DEVICE_REF, DEVICE_ID);
  ctx.deviceIdToRef.set(DEVICE_ID, DEVICE_REF);
  return ctx;
}

/*
 * ADR-021 §4 per-type codecs have landed for the hot, UUID-heavy types
 * (`marker_traversed`, `clearance_request`, `clearance_granted`, and the
 * `grant_clearance` command). For those, encode∘decode is byte-identical and
 * the frame fits 250 bytes — they pack each 36-char UUID to 16 raw bytes. Every
 * other type still rides the generic UTF-8-JSON carrier; for those the partition
 * below selects only the payloads the generic carrier can fit. A type with a
 * per-type codec is always tested for round-trip + size; a generic type that
 * overflows (a pathological/synthetic payload) keeps the documented throw.
 */
const TEST_PROTOCOL_VERSION = '0.4.0';
const ISO = '2026-06-09T00:00:00.000Z';

function eventEnvelopeFor(eventType: string, payload: unknown): EventEnvelope {
  return {
    event_id: `e-${eventType}`,
    device_id: DEVICE_ID,
    timestamp_device: ISO,
    event_type: eventType,
    protocol_version: TEST_PROTOCOL_VERSION,
    payload,
  };
}

function commandEnvelopeFor(commandType: string, payload: unknown): CommandEnvelope {
  return {
    command_id: `c-${commandType}`,
    device_id: DEVICE_ID,
    timestamp_server: ISO,
    command_type: commandType,
    protocol_version: TEST_PROTOCOL_VERSION,
    payload,
  };
}

function genericPayloadFits(payload: unknown): boolean {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return TCF_HEADER_BYTES + json.length <= ESP_NOW_MAX_FRAME_BYTES;
}

/* An event type fits one frame today iff it has a per-type codec or its
 * generic JSON carrier is under the limit. */
function eventFitsToday(eventType: string, payload: unknown): boolean {
  return eventPayloadCodec(eventType) !== undefined || genericPayloadFits(payload);
}

function commandFitsToday(commandType: string, payload: unknown): boolean {
  return commandPayloadCodec(commandType) !== undefined || genericPayloadFits(payload);
}

describe('TCF codec — header structure', () => {
  it('writes a 13-byte header with big-endian fields', () => {
    const ctx = pairedContext();
    const envelope: EventEnvelope = {
      event_id: 'e1',
      device_id: DEVICE_ID,
      timestamp_device: '2026-06-09T00:00:00.000Z',
      event_type: 'aspect_changed',
      protocol_version: '0.4.0',
      payload: { current_aspect: 'green' },
    };
    const frame = encodeEvent(envelope, ctx, { seq: 0x1234, uptimeMs: 0x00ff00ff });
    const view = new DataView(frame.buffer);
    expect(view.getUint8(0)).toBe(TCF_REGISTRY_EPOCH);
    expect(view.getUint8(1)).toBe(EVENT_TYPE_ORDER.indexOf('aspect_changed'));
    expect(view.getUint8(2) & TCF_FLAG_IS_COMMAND).toBe(0);
    expect(view.getUint32(3, false)).toBe(DEVICE_REF);
    expect(view.getUint16(7, false)).toBe(0x1234);
    expect(view.getUint32(9, false)).toBe(0x00ff00ff);
    expect(frame.length).toBeGreaterThan(TCF_HEADER_BYTES);
  });

  it('sets is_command on command frames and leaves cbor reserved (0)', () => {
    const ctx = pairedContext();
    const envelope: CommandEnvelope = {
      command_id: 'c1',
      device_id: DEVICE_ID,
      timestamp_server: '2026-06-09T00:00:00.000Z',
      command_type: 'set_aspect',
      protocol_version: '0.4.0',
      payload: { aspect: 'red' },
    };
    const frame = encodeCommand(envelope, ctx);
    const read = readFrame(frame);
    expect(read.isCommand).toBe(true);
    expect(read.payloadIsCbor).toBe(false);
    expect(read.typeId).toBe(commandTypeToId('set_aspect'));
    /* cbor bit never set by this codec (deferred, ADR-021 §4). */
    expect(new DataView(frame.buffer).getUint8(2) & TCF_FLAG_PAYLOAD_IS_CBOR).toBe(0);
  });
});

describe('TCF codec — frame size bound (ADR-021 §Context, 250 bytes)', () => {
  it('keeps every fitting event frame <= 250 bytes', () => {
    const ctx = pairedContext();
    let asserted = 0;
    for (const eventType of EVENT_TYPE_ORDER) {
      const payload = EVENT_PAYLOADS[eventType];
      if (!eventFitsToday(eventType, payload)) continue;
      const frame = encodeEvent(eventEnvelopeFor(eventType, payload), ctx);
      expect(frame.length, `${eventType} frame fits`).toBeLessThanOrEqual(ESP_NOW_MAX_FRAME_BYTES);
      asserted += 1;
    }
    expect(asserted).toBeGreaterThan(0);
  });

  it('keeps every fitting command frame <= 250 bytes', () => {
    const ctx = pairedContext();
    let asserted = 0;
    for (const commandType of COMMAND_TYPE_ORDER) {
      const payload = COMMAND_PAYLOADS[commandType];
      if (!commandFitsToday(commandType, payload)) continue;
      const frame = encodeCommand(commandEnvelopeFor(commandType, payload), ctx);
      expect(frame.length, `${commandType} frame fits`).toBeLessThanOrEqual(
        ESP_NOW_MAX_FRAME_BYTES,
      );
      asserted += 1;
    }
    expect(asserted).toBeGreaterThan(0);
  });

  it('fits the UUID-heavy clearance_request via its per-type codec (ADR-021 §4)', () => {
    /*
     * clearance_request is three full UUIDs and overflows 250 bytes as generic
     * JSON (the boundary this codec exists to break). The per-type codec packs
     * each UUID to 16 raw bytes, so it now FITS one frame and round-trips
     * byte-identically. This is the type the ADR's "frames fit" claim names.
     */
    const ctx = pairedContext();
    expect(genericPayloadFits(EVENT_PAYLOADS.clearance_request)).toBe(false);
    expect(eventPayloadCodec('clearance_request')).toBeDefined();
    const frame = encodeEvent(
      eventEnvelopeFor('clearance_request', EVENT_PAYLOADS.clearance_request),
      ctx,
    );
    expect(frame.length).toBeLessThanOrEqual(ESP_NOW_MAX_FRAME_BYTES);
    const decoded = decode(frame, ctx, makeDeps());
    if (decoded.kind !== 'event') throw new Error('expected event');
    expect(decoded.envelope.payload).toEqual(EVENT_PAYLOADS.clearance_request);
  });

  it('fits a marker_traversed carrying inferred_edge that overflows the generic carrier', () => {
    /*
     * A realistic marker_traversed with its optional inferred_edge is four
     * UUIDs and overflows the generic JSON carrier — the ADR's other named
     * "previously-overflowing" case. The per-type codec packs it well under 250.
     */
    const ctx = pairedContext();
    const payload = {
      train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      direction: 'forward',
      in_discovery_mode: true,
      inferred_edge: {
        from_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
        to_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      },
    };
    expect(genericPayloadFits(payload)).toBe(false);
    const frame = encodeEvent(eventEnvelopeFor('marker_traversed', payload), ctx);
    expect(frame.length).toBeLessThanOrEqual(ESP_NOW_MAX_FRAME_BYTES);
    const decoded = decode(frame, ctx, makeDeps());
    if (decoded.kind !== 'event') throw new Error('expected event');
    expect(decoded.envelope.payload).toEqual(payload);
  });

  it('rejects an over-large payload rather than emitting an oversized frame', () => {
    const ctx = pairedContext();
    const huge = { description: 'x'.repeat(ESP_NOW_MAX_FRAME_BYTES) };
    const envelope: EventEnvelope = {
      event_id: 'big',
      device_id: DEVICE_ID,
      timestamp_device: '2026-06-09T00:00:00.000Z',
      event_type: 'anomaly',
      protocol_version: '0.4.0',
      payload: huge,
    };
    expect(() => encodeEvent(envelope, ctx)).toThrow(/exceeds/);
  });
});

describe('TCF codec — round-trip (encode . decode == identity)', () => {
  it('rebuilds a byte-identical frame for every event type the carrier fits', () => {
    const deps = makeDeps();
    let roundTripped = 0;
    for (const [index, eventType] of EVENT_TYPE_ORDER.entries()) {
      const payload = EVENT_PAYLOADS[eventType];
      if (!eventFitsToday(eventType, payload)) continue;
      const ctx = pairedContext();
      const original = eventEnvelopeFor(eventType, payload);
      /* Seed a frame with concrete header values, decode it, re-encode it. */
      const seeded = encodeEvent(original, ctx, {
        seq: 100 + index,
        uptimeMs: 5000 + index,
        deviceRef: DEVICE_REF,
      });
      const decoded = decode(seeded, ctx, deps);
      expect(decoded.kind).toBe('event');
      if (decoded.kind !== 'event') throw new Error('unreachable');
      const reencoded = encodeEvent(decoded.envelope, ctx);
      expect(reencoded, `${eventType} round-trips byte-identically`).toEqual(seeded);
      roundTripped += 1;
    }
    expect(roundTripped).toBeGreaterThan(0);
  });

  it('rebuilds a byte-identical frame for every command type the carrier fits', () => {
    const deps = makeDeps();
    let roundTripped = 0;
    for (const [index, commandType] of COMMAND_TYPE_ORDER.entries()) {
      const payload = COMMAND_PAYLOADS[commandType];
      if (!commandFitsToday(commandType, payload)) continue;
      const ctx = pairedContext();
      const original = commandEnvelopeFor(commandType, payload);
      const seeded = encodeCommand(original, ctx, {
        seq: 200 + index,
        uptimeMs: 9000 + index,
        deviceRef: DEVICE_REF,
      });
      const decoded = decode(seeded, ctx, deps);
      expect(decoded.kind).toBe('command');
      if (decoded.kind !== 'command') throw new Error('unreachable');
      const reencoded = encodeCommand(decoded.envelope, ctx);
      expect(reencoded, `${commandType} round-trips byte-identically`).toEqual(seeded);
      roundTripped += 1;
    }
    expect(roundTripped).toBeGreaterThan(0);
  });

  it('expands a frame into a full canonical envelope (synthesised fields)', () => {
    const deps = makeDeps();
    const ctx = pairedContext();
    const frame = encodeEvent(
      {
        event_id: 'x',
        device_id: DEVICE_ID,
        timestamp_device: '2026-06-09T00:00:00.000Z',
        event_type: 'marker_traversed',
        protocol_version: '0.4.0',
        payload: EVENT_PAYLOADS.marker_traversed,
      },
      ctx,
      { seq: 7, uptimeMs: 1234, deviceRef: DEVICE_REF },
    );
    const decoded = decode(frame, ctx, deps);
    if (decoded.kind !== 'event') throw new Error('expected event');
    expect(decoded.envelope.event_type).toBe('marker_traversed');
    expect(decoded.envelope.device_id).toBe(DEVICE_ID);
    expect(decoded.envelope.protocol_version).toBe('0.4.0');
    expect(decoded.envelope.timestamp_device).toBe('2026-06-09T00:00:00.000Z');
    expect(decoded.envelope.event_id).toMatch(/^1{8}-/);
    expect(decoded.envelope.payload).toEqual(EVENT_PAYLOADS.marker_traversed);
  });

  it('maps command_id <-> seq across the round-trip (ADR-021 §6)', () => {
    const deps = makeDeps();
    const ctx = pairedContext();
    const frame = encodeCommand(
      {
        command_id: 'orig',
        device_id: DEVICE_ID,
        timestamp_server: '2026-06-09T00:00:00.000Z',
        command_type: 'grant_clearance',
        protocol_version: '0.4.0',
        payload: COMMAND_PAYLOADS.grant_clearance,
      },
      ctx,
      { seq: 42, uptimeMs: 0, deviceRef: DEVICE_REF },
    );
    const decoded = decode(frame, ctx, deps);
    if (decoded.kind !== 'command') throw new Error('expected command');
    const corr = ctx.idToSeqUptime.get(decoded.envelope.command_id);
    expect(corr?.seq).toBe(42);
    /* Re-encoding using only the synthesised command_id recovers seq 42. */
    const reencoded = encodeCommand(decoded.envelope, ctx);
    expect(readFrame(reencoded).seq).toBe(42);
  });
});

describe('TCF codec — device identity (ADR-021 §5)', () => {
  it('synthesises a stable device_id for an unknown device_ref', () => {
    const deps = makeDeps();
    const ctx = createBridgeContext();
    const frame = encodeEvent(
      {
        event_id: 'x',
        device_id: 'whatever',
        timestamp_device: '2026-06-09T00:00:00.000Z',
        event_type: 'aspect_changed',
        protocol_version: '0.4.0',
        payload: { current_aspect: 'green' },
      },
      ctx,
      { deviceRef: 0x000000ff, seq: 1, uptimeMs: 0 },
    );
    const first = decode(frame, ctx, deps);
    const second = decode(frame, ctx, deps);
    if (first.kind !== 'event' || second.kind !== 'event') throw new Error('unreachable');
    expect(first.envelope.device_id).toBe(second.envelope.device_id);
    expect(first.envelope.device_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('TCF codec — unknown type id is default-safe (ADR-021 §3)', () => {
  it('expands an unknown event type_id to an anomaly event', () => {
    const deps = makeDeps();
    const ctx = pairedContext();
    /* Hand-craft a frame with a type_id beyond the registry. */
    const frame = new Uint8Array(TCF_HEADER_BYTES);
    const view = new DataView(frame.buffer);
    view.setUint8(0, TCF_REGISTRY_EPOCH);
    view.setUint8(1, 200); /* unknown event id */
    view.setUint8(2, 0); /* event, not command */
    view.setUint32(3, DEVICE_REF, false);
    const decoded = decode(frame, ctx, deps);
    if (decoded.kind !== 'event') throw new Error('expected event');
    expect(decoded.envelope.event_type).toBe('anomaly');
    const payload = decoded.envelope.payload as { severity: string; context: { type_id: number } };
    expect(payload.severity).toBe('warning');
    expect(payload.context.type_id).toBe(200);
  });

  it('expands an unknown command type_id to an anomaly event (not a guessed command)', () => {
    const deps = makeDeps();
    const ctx = pairedContext();
    const frame = new Uint8Array(TCF_HEADER_BYTES);
    const view = new DataView(frame.buffer);
    view.setUint8(0, TCF_REGISTRY_EPOCH);
    view.setUint8(1, 200);
    view.setUint8(2, TCF_FLAG_IS_COMMAND);
    view.setUint32(3, DEVICE_REF, false);
    const decoded = decode(frame, ctx, deps);
    expect(decoded.kind).toBe('event');
    if (decoded.kind !== 'event') throw new Error('unreachable');
    expect(decoded.envelope.event_type).toBe('anomaly');
  });
});

describe('TCF codec — epoch handling (ADR-021 §3)', () => {
  it('carries the sender epoch through decode for mixed-fleet routing', () => {
    const deps = makeDeps();
    const ctx = pairedContext();
    const frame = new Uint8Array(TCF_HEADER_BYTES);
    const view = new DataView(frame.buffer);
    const olderEpoch = TCF_REGISTRY_EPOCH; /* same-or-older: append-only safe */
    view.setUint8(0, olderEpoch);
    view.setUint8(1, EVENT_TYPE_ORDER.indexOf('device_registered'));
    view.setUint8(2, 0);
    view.setUint32(3, DEVICE_REF, false);
    const read = readFrame(frame);
    expect(read.versionEpoch).toBe(olderEpoch);
    /* device_registered (id 0) decodes regardless of epoch (stable lowest id). */
    const decoded = decode(frame, ctx, deps);
    if (decoded.kind !== 'event') throw new Error('expected event');
    expect(decoded.envelope.event_type).toBe('device_registered');
  });

  it('surfaces a newer-epoch unknown id as an anomaly with the epoch recorded', () => {
    const deps = makeDeps();
    const ctx = pairedContext();
    const frame = new Uint8Array(TCF_HEADER_BYTES);
    const view = new DataView(frame.buffer);
    const newerEpoch = TCF_REGISTRY_EPOCH + 5;
    view.setUint8(0, newerEpoch);
    view.setUint8(1, 240); /* a type only the newer device knows */
    view.setUint8(2, 0);
    view.setUint32(3, DEVICE_REF, false);
    const decoded = decode(frame, ctx, deps);
    if (decoded.kind !== 'event') throw new Error('expected event');
    expect(decoded.envelope.event_type).toBe('anomaly');
    const payload = decoded.envelope.payload as { context: { version_epoch: number } };
    expect(payload.context.version_epoch).toBe(newerEpoch);
  });
});

describe('TCF codec — structural validation', () => {
  it('throws on a frame shorter than the header', () => {
    const deps = makeDeps();
    const ctx = pairedContext();
    expect(() => decode(new Uint8Array(5), ctx, deps)).toThrow(/too short/);
  });

  it('throws on a payload that is not valid JSON', () => {
    const frame = new Uint8Array(TCF_HEADER_BYTES + 3);
    frame[TCF_HEADER_BYTES] = 0x7b; /* '{' then garbage */
    frame[TCF_HEADER_BYTES + 1] = 0xff;
    frame[TCF_HEADER_BYTES + 2] = 0xfe;
    expect(() => readFrame(frame)).toThrow();
  });

  it('throws when encoding a type with no compact ID (programmer error)', () => {
    const ctx = pairedContext();
    const bad: EventEnvelope = {
      event_id: 'x',
      device_id: DEVICE_ID,
      timestamp_device: '2026-06-09T00:00:00.000Z',
      event_type: 'not_a_real_event',
      protocol_version: '0.4.0',
      payload: {},
    };
    expect(() => encodeEvent(bad, ctx)).toThrow(/No TCF compact ID/);
  });

  it('throws when encoding a command type with no compact ID', () => {
    const ctx = pairedContext();
    const bad: CommandEnvelope = {
      command_id: 'x',
      device_id: DEVICE_ID,
      timestamp_server: ISO,
      command_type: 'not_a_real_command',
      protocol_version: TEST_PROTOCOL_VERSION,
      payload: {},
    };
    expect(() => encodeCommand(bad, ctx)).toThrow(/No TCF compact ID/);
  });

  it('rejects out-of-range header field values', () => {
    const ctx = pairedContext();
    const envelope: EventEnvelope = {
      event_id: 'x',
      device_id: DEVICE_ID,
      timestamp_device: '2026-06-09T00:00:00.000Z',
      event_type: 'aspect_changed',
      protocol_version: '0.4.0',
      payload: { current_aspect: 'green' },
    };
    expect(() => encodeEvent(envelope, ctx, { seq: 0x1_0000 })).toThrow(/seq/);
    expect(() => encodeEvent(envelope, ctx, { deviceRef: -1 })).toThrow(/device_ref/);
  });

  it('encodes an empty payload object to a header-only frame', () => {
    const ctx = pairedContext();
    const envelope: CommandEnvelope = {
      command_id: 'c',
      device_id: DEVICE_ID,
      timestamp_server: '2026-06-09T00:00:00.000Z',
      command_type: 'emergency_stop',
      protocol_version: '0.4.0',
      payload: {},
    };
    const frame = encodeCommand(envelope, ctx);
    expect(frame.length).toBe(TCF_HEADER_BYTES);
    expect(readFrame(frame).payload).toEqual({});
  });
});

describe('TCF per-type payload codecs (ADR-021 §4)', () => {
  function roundTripEvent(eventType: string, payload: unknown): unknown {
    const ctx = pairedContext();
    const frame = encodeEvent(eventEnvelopeFor(eventType, payload), ctx, {
      seq: 9,
      uptimeMs: 99,
      deviceRef: DEVICE_REF,
    });
    expect(frame.length).toBeLessThanOrEqual(ESP_NOW_MAX_FRAME_BYTES);
    return readFrame(frame).payload;
  }

  it('marker_traversed round-trips WITH inferred_edge present', () => {
    const payload = {
      train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      direction: 'reverse',
      in_discovery_mode: true,
      inferred_edge: {
        from_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
        to_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      },
    };
    expect(roundTripEvent('marker_traversed', payload)).toEqual(payload);
  });

  it('marker_traversed round-trips WITHOUT inferred_edge (key stays absent)', () => {
    const payload = {
      train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      direction: 'forward',
      in_discovery_mode: false,
    };
    const decoded = roundTripEvent('marker_traversed', payload);
    expect(decoded).toEqual(payload);
    expect(Object.hasOwn(decoded as object, 'inferred_edge')).toBe(false);
  });

  it('clearance_granted round-trips an EMPTY edge array', () => {
    const payload = {
      train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      new_limit_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      edges_newly_cleared: [],
    };
    expect(roundTripEvent('clearance_granted', payload)).toEqual(payload);
  });

  it('clearance_granted round-trips a NON-EMPTY edge array', () => {
    const payload = {
      train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      new_limit_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      edges_newly_cleared: [
        {
          from_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
          to_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
        },
        {
          from_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
          to_marker_id: 'aaaaaaaa-0000-4000-8000-000000000004',
        },
      ],
    };
    expect(roundTripEvent('clearance_granted', payload)).toEqual(payload);
  });

  it('grant_clearance command round-trips WITH and WITHOUT optional reason', () => {
    const ctx = pairedContext();
    const withReason = {
      limit_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      reason: 'block ahead clear — proceed (héllo)',
    };
    const withoutReason = { limit_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003' };
    for (const payload of [withReason, withoutReason]) {
      const frame = encodeCommand(commandEnvelopeFor('grant_clearance', payload), ctx, {
        deviceRef: DEVICE_REF,
      });
      expect(frame.length).toBeLessThanOrEqual(ESP_NOW_MAX_FRAME_BYTES);
      expect(readFrame(frame).payload).toEqual(payload);
    }
  });

  it('throws on a UUID-shaped field that is not a UUID (programmer error)', () => {
    const ctx = pairedContext();
    const bad = {
      train_id: 'not-a-uuid',
      current_limit_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      next_edge: {
        from_marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
        to_marker_id: 'aaaaaaaa-0000-4000-8000-000000000003',
      },
    };
    expect(() => encodeEvent(eventEnvelopeFor('clearance_request', bad), ctx)).toThrow(/UUID/);
  });

  it('throws when a per-type field has the wrong primitive type', () => {
    const ctx = pairedContext();
    const bad = {
      train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      direction: 'forward',
      in_discovery_mode: 'yes' /* not a boolean */,
    };
    expect(() => encodeEvent(eventEnvelopeFor('marker_traversed', bad), ctx)).toThrow(/boolean/);
  });

  it('throws on an unknown direction enum value', () => {
    const ctx = pairedContext();
    const bad = {
      train_id: 'aaaaaaaa-0000-4000-8000-000000000001',
      marker_id: 'aaaaaaaa-0000-4000-8000-000000000002',
      direction: 'sideways',
      in_discovery_mode: false,
    };
    expect(() => encodeEvent(eventEnvelopeFor('marker_traversed', bad), ctx)).toThrow(/direction/);
  });

  it('throws on a non-object per-type payload', () => {
    const ctx = pairedContext();
    expect(() => encodeEvent(eventEnvelopeFor('clearance_request', 'nope'), ctx)).toThrow(
      /expected an object/,
    );
  });

  it('throws decoding a corrupt per-type frame with trailing bytes', () => {
    const ctx = pairedContext();
    const frame = encodeEvent(
      eventEnvelopeFor('clearance_request', EVENT_PAYLOADS.clearance_request),
      ctx,
      { deviceRef: DEVICE_REF },
    );
    /* Append a stray byte to the payload region. */
    const corrupt = new Uint8Array(frame.length + 1);
    corrupt.set(frame, 0);
    expect(() => readFrame(corrupt)).toThrow(/trailing bytes/);
  });

  it('throws decoding a per-type frame that is truncated mid-field', () => {
    const ctx = pairedContext();
    const frame = encodeEvent(
      eventEnvelopeFor('clearance_request', EVENT_PAYLOADS.clearance_request),
      ctx,
      { deviceRef: DEVICE_REF },
    );
    /* Drop the last byte so a UUID read runs off the end. */
    const truncated = frame.subarray(0, frame.length - 1);
    expect(() => readFrame(truncated)).toThrow(/ran out of bytes/);
  });
});
