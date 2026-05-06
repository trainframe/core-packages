import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES, gatesClearanceCapability } from './builtins/index.js';
import type { Capability } from './capability.js';
import { CapabilityRegistry } from './registry.js';

const fakeSatellite: Capability<Record<string, never>> = {
  id: 'com.test.fake_capability',
  description: 'A capability invented for tests.',
  customEvents: [],
  customCommands: [],
  stateSchema: Type.Object({}),
  initialState: () => ({}),
  hooks: {},
};

describe('CapabilityRegistry', () => {
  it('registers built-ins and a satellite the same way', () => {
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.register(fakeSatellite);
    registry.freeze();

    expect(registry.has('core.gates_clearance')).toBe(true);
    expect(registry.has('com.test.fake_capability')).toBe(true);
    expect(registry.ids()).toHaveLength(BUILTIN_CAPABILITIES.length + 1);
  });

  it('rejects duplicate registration', () => {
    const registry = new CapabilityRegistry();
    registry.register(gatesClearanceCapability);
    expect(() => registry.register(gatesClearanceCapability)).toThrow(/already registered/);
  });

  it('rejects registration after freeze', () => {
    const registry = new CapabilityRegistry();
    registry.freeze();
    expect(() => registry.register(fakeSatellite)).toThrow(/frozen/);
  });

  it('flags unknown capabilities a device declares', () => {
    const registry = new CapabilityRegistry();
    registry.registerAll(BUILTIN_CAPABILITIES);
    registry.freeze();

    const unknown = registry.validateDeviceCapabilities([
      'core.gates_clearance',
      'com.unknown.something',
    ]);
    expect(unknown).toEqual(['com.unknown.something']);
  });
});

describe('gates_clearance capability behaviour', () => {
  it('records a withhold when receiving gate_state_changed: withholding', () => {
    const initial = gatesClearanceCapability.initialState('device-1');
    const result = gatesClearanceCapability.hooks.onEvent?.(initial, {
      device_id: 'device-1',
      event_type: 'gate_state_changed',
      payload: { marker_id: 'M3', state: 'withholding', reason: 'crane busy' },
      device_capabilities: ['core.gates_clearance'],
    });

    expect(result?.newState.withheld_markers).toEqual([{ marker_id: 'M3', reason: 'crane busy' }]);
  });

  it('votes deny when consulted on a withheld marker', () => {
    const state = { withheld_markers: [{ marker_id: 'M3', reason: 'crane busy' }] };
    const vote = gatesClearanceCapability.hooks.onClearanceConsultation?.(state, {
      train_id: 'T1',
      current_limit_marker_id: 'M2',
      proposed_new_limit_marker_id: 'M3',
      proposed_edges_to_clear: [{ from_marker_id: 'M2', to_marker_id: 'M3' }],
    });

    expect(vote).toEqual({ vote: 'deny', reason: 'gated by device: crane busy' });
  });

  it('abstains when consulted on a non-withheld marker', () => {
    const state = { withheld_markers: [{ marker_id: 'M3', reason: 'crane busy' }] };
    const vote = gatesClearanceCapability.hooks.onClearanceConsultation?.(state, {
      train_id: 'T1',
      current_limit_marker_id: 'M2',
      proposed_new_limit_marker_id: 'M5',
      proposed_edges_to_clear: [{ from_marker_id: 'M2', to_marker_id: 'M5' }],
    });

    expect(vote).toEqual({ vote: 'abstain' });
  });
});
