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
 * Does a payload fit one frame under THIS PR's interim generic-JSON carrier?
 *
 * Reconciliation with ADR-021 §2/§Consequences ("frames fit"): the ADR's
 * "frames fit" claim rests on §4's per-type codec packing UUIDs down to short
 * refs — that byte layout is the ADR's *named deferred follow-up*. Until it
 * lands, the generic carrier keeps full 36-char UUID strings, so UUID-heavy
 * core payloads (e.g. clearance_request, three UUIDs) overflow 250 bytes and
 * the codec refuses to emit them. We therefore partition the type set by what
 * the generic carrier can carry today, asserting the bound on the fitting set
 * and the documented throw on the overflowing set. Each type graduates from
 * "throws" to "round-trips" automatically once a per-type codec shrinks it.
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
      if (!genericPayloadFits(payload)) continue;
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
      if (!genericPayloadFits(payload)) continue;
      const frame = encodeCommand(commandEnvelopeFor(commandType, payload), ctx);
      expect(frame.length, `${commandType} frame fits`).toBeLessThanOrEqual(
        ESP_NOW_MAX_FRAME_BYTES,
      );
      asserted += 1;
    }
    expect(asserted).toBeGreaterThan(0);
  });

  it('refuses to emit a UUID-heavy core payload under the interim generic carrier', () => {
    /*
     * clearance_request is three full UUIDs — no arrays, the minimal hot-path
     * shape — and overflows 250 bytes as generic JSON. The ADR's per-type ref
     * codec (§4, deferred) is what shrinks the UUIDs to short refs so it fits;
     * until then, the codec refuses rather than emit an oversized frame
     * (ADR-021 §4: an unfittable frame is "the bridge's problem to solve over a
     * slower path"). This documents the boundary as a tested fact.
     */
    const ctx = pairedContext();
    expect(genericPayloadFits(EVENT_PAYLOADS.clearance_request)).toBe(false);
    expect(() =>
      encodeEvent(eventEnvelopeFor('clearance_request', EVENT_PAYLOADS.clearance_request), ctx),
    ).toThrow(/exceeds/);
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
      /* Overflowing types graduate to round-trip when per-type codecs land. */
      if (!genericPayloadFits(payload)) continue;
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
      if (!genericPayloadFits(payload)) continue;
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
