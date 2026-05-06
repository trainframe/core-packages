import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

// TypeBox treats `format` as opt-in. Consumers (this package's downstream
// validators) register their own; the schemas themselves are framework-neutral.
// For these tests we register the formats this package actually uses, so
// `Value.Check` enforces them.
FormatRegistry.Set('uuid', (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
);
FormatRegistry.Set('date-time', (value) => !Number.isNaN(Date.parse(value)));
FormatRegistry.Set('uri', (value) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
});
import { BUILTIN_CAPABILITIES, CapabilityId } from './capabilities.js';
import {
  AssignRoute,
  CORE_COMMAND_SCHEMAS,
  CoreCommand,
  EmergencyStop,
  GrantClearance,
} from './commands.js';
import { Direction, EdgeRef, Iso8601, Uuid } from './envelope.js';
import {
  Anomaly,
  CORE_EVENT_SCHEMAS,
  ClearanceGranted,
  ClearanceRequest,
  ClearanceRevoked,
  CoreEvent,
  DeviceRegistered,
  GateStateChanged,
  MarkerTraversed,
  SwitchStateChanged,
  TagObserved,
  TrainStatus,
} from './events.js';
import { Layout } from './layout.js';
import { DeviceManifest } from './manifest.js';
import { PROTOCOL_VERSION } from './version.js';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';
const OTHER_UUID = '00000000-0000-4000-8000-000000000002';
const VALID_TS = '2026-05-06T12:00:00Z';

const baseEnvelope = (eventType: string, payload: unknown) => ({
  event_id: VALID_UUID,
  device_id: VALID_UUID,
  timestamp_device: VALID_TS,
  event_type: eventType,
  protocol_version: PROTOCOL_VERSION,
  payload,
});

const baseCommandEnvelope = (commandType: string, payload: unknown) => ({
  command_id: VALID_UUID,
  device_id: VALID_UUID,
  timestamp_server: VALID_TS,
  command_type: commandType,
  protocol_version: PROTOCOL_VERSION,
  payload,
});

describe('PROTOCOL_VERSION', () => {
  it('is a fixed semver-shaped string', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('atomic schemas', () => {
  it('Uuid accepts a valid UUID and rejects junk', () => {
    expect(Value.Check(Uuid, VALID_UUID)).toBe(true);
    expect(Value.Check(Uuid, 'not-a-uuid')).toBe(false);
  });

  it('Iso8601 accepts a valid timestamp and rejects junk', () => {
    expect(Value.Check(Iso8601, VALID_TS)).toBe(true);
    expect(Value.Check(Iso8601, 'yesterday')).toBe(false);
  });

  it('Direction accepts only forward or reverse', () => {
    expect(Value.Check(Direction, 'forward')).toBe(true);
    expect(Value.Check(Direction, 'reverse')).toBe(true);
    expect(Value.Check(Direction, 'sideways')).toBe(false);
  });

  it('EdgeRef requires both marker IDs', () => {
    expect(Value.Check(EdgeRef, { from_marker_id: VALID_UUID, to_marker_id: OTHER_UUID })).toBe(
      true,
    );
    expect(Value.Check(EdgeRef, { from_marker_id: VALID_UUID })).toBe(false);
  });
});

describe('capabilities', () => {
  it('BUILTIN_CAPABILITIES includes the documented core set', () => {
    expect(BUILTIN_CAPABILITIES).toContain('core.gates_clearance');
    expect(BUILTIN_CAPABILITIES).toContain('core.controls_motion');
  });

  it('CapabilityId accepts dotted lowercase identifiers', () => {
    expect(Value.Check(CapabilityId, 'core.gates_clearance')).toBe(true);
    expect(Value.Check(CapabilityId, 'com.alice.controls-turntable')).toBe(true);
  });

  it('CapabilityId rejects identifiers with whitespace, uppercase, or invalid edges', () => {
    expect(Value.Check(CapabilityId, 'Core.Gates')).toBe(false);
    expect(Value.Check(CapabilityId, 'has space')).toBe(false);
    expect(Value.Check(CapabilityId, 'a')).toBe(false);
    expect(Value.Check(CapabilityId, '.starts.with.dot')).toBe(false);
  });
});

describe('event envelope and core event schemas', () => {
  it('DeviceRegistered validates a well-formed payload', () => {
    const payload = {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
      device_kind_hint: 'train',
    };
    expect(Value.Check(DeviceRegistered, baseEnvelope('device_registered', payload))).toBe(true);
  });

  it('DeviceRegistered rejects mismatched event_type', () => {
    const payload = { capabilities: ['core.controls_motion'], device_kind_hint: 'train' };
    expect(Value.Check(DeviceRegistered, baseEnvelope('something_else', payload))).toBe(false);
  });

  it('TagObserved requires a non-empty tag_id', () => {
    expect(Value.Check(TagObserved, baseEnvelope('tag_observed', { tag_id: 'M1' }))).toBe(true);
    expect(Value.Check(TagObserved, baseEnvelope('tag_observed', { tag_id: '' }))).toBe(false);
  });

  it('MarkerTraversed validates a well-formed payload', () => {
    const payload = {
      train_id: VALID_UUID,
      marker_id: OTHER_UUID,
      direction: 'forward',
      in_discovery_mode: false,
    };
    expect(Value.Check(MarkerTraversed, baseEnvelope('marker_traversed', payload))).toBe(true);
  });

  it('TrainStatus enforces speed_normalised is between 0 and 1', () => {
    const payload = { train_id: VALID_UUID, speed_normalised: 0.5 };
    expect(Value.Check(TrainStatus, baseEnvelope('train_status', payload))).toBe(true);
    expect(
      Value.Check(TrainStatus, baseEnvelope('train_status', { ...payload, speed_normalised: 1.5 })),
    ).toBe(false);
  });

  it('ClearanceRequest requires a next edge', () => {
    const payload = {
      train_id: VALID_UUID,
      current_limit_marker_id: OTHER_UUID,
      next_edge: { from_marker_id: VALID_UUID, to_marker_id: OTHER_UUID },
    };
    expect(Value.Check(ClearanceRequest, baseEnvelope('clearance_request', payload))).toBe(true);
  });

  it('ClearanceGranted accepts a list of newly-cleared edges', () => {
    const payload = {
      train_id: VALID_UUID,
      new_limit_marker_id: OTHER_UUID,
      edges_newly_cleared: [{ from_marker_id: VALID_UUID, to_marker_id: OTHER_UUID }],
    };
    expect(Value.Check(ClearanceGranted, baseEnvelope('clearance_granted', payload))).toBe(true);
  });

  it('ClearanceRevoked validates a well-formed payload', () => {
    const payload = { train_id: VALID_UUID, reason: 'manual', immediate: true };
    expect(Value.Check(ClearanceRevoked, baseEnvelope('clearance_revoked', payload))).toBe(true);
  });

  it('GateStateChanged accepts only granting or withholding', () => {
    expect(
      Value.Check(
        GateStateChanged,
        baseEnvelope('gate_state_changed', { marker_id: VALID_UUID, state: 'withholding' }),
      ),
    ).toBe(true);
    expect(
      Value.Check(
        GateStateChanged,
        baseEnvelope('gate_state_changed', { marker_id: VALID_UUID, state: 'something' }),
      ),
    ).toBe(false);
  });

  it('SwitchStateChanged validates a well-formed payload', () => {
    const payload = { junction_marker_id: VALID_UUID, position: 'main', confirmed: true };
    expect(Value.Check(SwitchStateChanged, baseEnvelope('switch_state_changed', payload))).toBe(
      true,
    );
  });

  it('Anomaly accepts info/warning/error severities', () => {
    for (const severity of ['info', 'warning', 'error']) {
      const payload = { severity, description: 'something happened' };
      expect(Value.Check(Anomaly, baseEnvelope('anomaly', payload))).toBe(true);
    }
  });

  it('CoreEvent accepts any of the discriminated members', () => {
    const tagObserved = baseEnvelope('tag_observed', { tag_id: 'M1' });
    const anomaly = baseEnvelope('anomaly', { severity: 'info', description: 'x' });
    expect(Value.Check(CoreEvent, tagObserved)).toBe(true);
    expect(Value.Check(CoreEvent, anomaly)).toBe(true);
  });

  it('CORE_EVENT_SCHEMAS exposes a schema for every documented event_type', () => {
    expect(Object.keys(CORE_EVENT_SCHEMAS)).toEqual(
      expect.arrayContaining([
        'device_registered',
        'tag_observed',
        'marker_traversed',
        'train_status',
        'clearance_request',
        'clearance_granted',
        'clearance_revoked',
        'gate_state_changed',
        'switch_state_changed',
        'aspect_changed',
        'tag_assignment',
        'anomaly',
      ]),
    );
  });
});

describe('command envelope and core command schemas', () => {
  it('AssignRoute requires at least one edge', () => {
    const goodPayload = {
      route_id: VALID_UUID,
      edges: [{ from_marker_id: VALID_UUID, to_marker_id: OTHER_UUID }],
    };
    const emptyPayload = { route_id: VALID_UUID, edges: [] };
    expect(Value.Check(AssignRoute, baseCommandEnvelope('assign_route', goodPayload))).toBe(true);
    expect(Value.Check(AssignRoute, baseCommandEnvelope('assign_route', emptyPayload))).toBe(false);
  });

  it('GrantClearance validates a well-formed command', () => {
    expect(
      Value.Check(
        GrantClearance,
        baseCommandEnvelope('grant_clearance', { limit_marker_id: VALID_UUID }),
      ),
    ).toBe(true);
  });

  it('EmergencyStop accepts an empty payload', () => {
    expect(Value.Check(EmergencyStop, baseCommandEnvelope('emergency_stop', {}))).toBe(true);
  });

  it('CoreCommand accepts members of the discriminated union', () => {
    expect(
      Value.Check(
        CoreCommand,
        baseCommandEnvelope('grant_clearance', { limit_marker_id: VALID_UUID }),
      ),
    ).toBe(true);
  });

  it('CORE_COMMAND_SCHEMAS exposes a schema for every documented command_type', () => {
    expect(Object.keys(CORE_COMMAND_SCHEMAS)).toEqual(
      expect.arrayContaining([
        'assign_route',
        'grant_clearance',
        'revoke_clearance',
        'set_target_speed',
        'emergency_stop',
        'set_switch_position',
        'set_aspect',
        'assign_tag',
      ]),
    );
  });
});

describe('Layout', () => {
  it('validates a minimal but well-formed layout', () => {
    const layout = {
      name: 'simple-loop',
      markers: [{ id: VALID_UUID, kind: 'block_boundary' }],
      edges: [{ from_marker_id: VALID_UUID, to_marker_id: OTHER_UUID }],
      junctions: [],
    };
    expect(Value.Check(Layout, layout)).toBe(true);
  });

  it('rejects a layout with an unknown marker kind', () => {
    const layout = {
      name: 'simple-loop',
      markers: [{ id: VALID_UUID, kind: 'not_a_kind' }],
      edges: [],
      junctions: [],
    };
    expect(Value.Check(Layout, layout)).toBe(false);
  });
});

describe('DeviceManifest', () => {
  it('validates a manifest with the required fields', () => {
    const manifest = {
      manifest_version: '1.0',
      vendor: 'com.alice',
      device_kind: 'turntable',
      version: '0.1.0',
      protocol_version: PROTOCOL_VERSION,
      display_name: 'Alice Turntable',
      description: 'A motorised turntable.',
      capabilities: ['core.gates_clearance'],
    };
    expect(Value.Check(DeviceManifest, manifest)).toBe(true);
  });

  it('rejects a manifest with a non-semver protocol_version', () => {
    const manifest = {
      manifest_version: '1.0',
      vendor: 'com.alice',
      device_kind: 'turntable',
      version: '0.1.0',
      protocol_version: 'latest',
      display_name: 'Alice Turntable',
      description: 'A motorised turntable.',
      capabilities: ['core.gates_clearance'],
    };
    expect(Value.Check(DeviceManifest, manifest)).toBe(false);
  });

  it('requires at least one capability', () => {
    const manifest = {
      manifest_version: '1.0',
      vendor: 'com.alice',
      device_kind: 'turntable',
      version: '0.1.0',
      protocol_version: PROTOCOL_VERSION,
      display_name: 'Alice Turntable',
      description: 'A motorised turntable.',
      capabilities: [],
    };
    expect(Value.Check(DeviceManifest, manifest)).toBe(false);
  });
});
