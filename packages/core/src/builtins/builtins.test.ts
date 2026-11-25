import { describe, expect, it } from 'vitest';
import { TagRegistry } from '../scheduler/tag-registry.js';
import { gatesClearanceCapability, gatesZoneCapability } from './index.js';

describe('gates_clearance hooks', () => {
  const event = (payload: Record<string, unknown>, event_type = 'gate_state_changed') => ({
    device_id: 'd1',
    device_capabilities: ['core.gates_clearance'],
    event_type,
    payload,
  });
  const onEvent = gatesClearanceCapability.hooks.onEvent;

  it('ignores events other than gate_state_changed', () => {
    const state = gatesClearanceCapability.initialState('d1');
    const result = onEvent?.(state, event({}, 'something_else'));
    expect(result?.newState).toBe(state);
    expect(result?.intents).toEqual([]);
  });

  it('keeps one entry when the same marker is withheld twice', () => {
    const first = onEvent?.(
      gatesClearanceCapability.initialState('d1'),
      event({ marker_id: 'M3', state: 'withholding' }),
    );
    expect(first?.newState.withheld_markers).toEqual([{ marker_id: 'M3', reason: 'gated' }]);
    const again = onEvent?.(
      first?.newState ?? { withheld_markers: [] },
      event({ marker_id: 'M3', state: 'withholding', reason: 'late' }),
    );
    expect(again?.newState).toBe(first?.newState);
  });

  it('removes only the granted marker', () => {
    let state = gatesClearanceCapability.initialState('d1');
    for (const m of ['M3', 'M4']) {
      state = onEvent?.(state, event({ marker_id: m, state: 'withholding' }))?.newState ?? state;
    }
    const granted = onEvent?.(state, event({ marker_id: 'M3', state: 'granting' }));
    expect(granted?.newState.withheld_markers.map((w) => w.marker_id)).toEqual(['M4']);
  });
});

describe('TagRegistry clear', () => {
  it('forgets every binding', () => {
    const registry = new TagRegistry();
    registry.assign('A', { kind: 'marker', target_id: 'M1' });
    registry.assign('B', { kind: 'vehicle', target_id: 'T1' });
    registry.clear();
    expect(registry.entries()).toHaveLength(0);
    expect(registry.resolve('A')).toBeUndefined();
  });
});

describe('gates_zone capability', () => {
  it('has a stable id and fresh initial state per device', () => {
    expect(gatesZoneCapability.id).toBe('core.gates_zone');
    expect(gatesZoneCapability.initialState('d1')).not.toBe(gatesZoneCapability.initialState('d2'));
  });
});
