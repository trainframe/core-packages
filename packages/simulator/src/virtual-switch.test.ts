import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';
import { VirtualSwitch } from './virtual-switch.js';

// ---------------------------------------------------------------------------
// VirtualSwitch unit tests
// ---------------------------------------------------------------------------

describe('VirtualSwitch', () => {
  function makeSwitch(
    deviceId = 'SWITCH-jct-1',
    junctionMarkerId = 'M-jct-1',
  ): {
    sw: VirtualSwitch;
    events: Array<{ event_type: string; device_id: string; payload: unknown }>;
  } {
    const events: Array<{ event_type: string; device_id: string; payload: unknown }> = [];
    const sw = new VirtualSwitch(deviceId, junctionMarkerId, (e) => events.push(e));
    return { sw, events };
  }

  it('register() emits device_registered with core.controls_switch and controls_marker_id', () => {
    const { sw, events } = makeSwitch();
    sw.register();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.event_type).toBe('device_registered');
    expect(ev?.device_id).toBe('SWITCH-jct-1');
    const payload = ev?.payload as { capabilities: string[]; controls_marker_id: string };
    expect(payload.capabilities).toEqual(['core.controls_switch']);
    expect(payload.controls_marker_id).toBe('M-jct-1');
  });

  it('acceptCommand(set_switch_position) emits switch_state_changed with confirmed: true', () => {
    const { sw, events } = makeSwitch();
    sw.register();
    sw.acceptCommand('set_switch_position', { junction_marker_id: 'M-jct-1', position: 'divert' });
    expect(events).toHaveLength(2);
    const ev = events[1];
    expect(ev?.event_type).toBe('switch_state_changed');
    // device_id on switch_state_changed is the switch device id, not the marker id.
    expect(ev?.device_id).toBe('SWITCH-jct-1');
    const p = ev?.payload as { junction_marker_id: string; position: string; confirmed: boolean };
    // junction_marker_id in the payload is the logical junction marker.
    expect(p.junction_marker_id).toBe('M-jct-1');
    expect(p.position).toBe('divert');
    expect(p.confirmed).toBe(true);
  });

  it('ignores unrecognised commands silently', () => {
    const { sw, events } = makeSwitch();
    sw.register();
    sw.acceptCommand('unknown_command', { position: 'main' });
    // Only the register event — no extra event from the unknown command.
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Simulation.spawnSwitch / despawnSwitch integration
// ---------------------------------------------------------------------------

describe('Simulation.spawnSwitch', () => {
  const EMPTY_LAYOUT = { name: 'test', markers: [], edges: [], junctions: [] };

  it('registers the switch and broadcasts device_registered with controls_marker_id', () => {
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    sim.spawnSwitch('SWITCH-jct-1', 'M-jct-1');
    const regs = sim.getEventsOfType('device_registered');
    expect(regs.length).toBe(1);
    const reg = regs[0];
    expect(reg?.device_id).toBe('SWITCH-jct-1');
    const payload = reg?.payload as { capabilities: string[]; controls_marker_id: string };
    expect(payload.capabilities).toEqual(['core.controls_switch']);
    expect(payload.controls_marker_id).toBe('M-jct-1');
  });

  it('routes set_switch_position to the switch device and emits switch_state_changed', () => {
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    sim.spawnSwitch('SWITCH-jct-1', 'M-jct-1');
    // Commands are addressed to the switch device id, not the marker id.
    sim.handleCommand('SWITCH-jct-1', 'set_switch_position', {
      junction_marker_id: 'M-jct-1',
      position: 'main',
    });
    const changed = sim.getEventsOfType('switch_state_changed');
    expect(changed).toHaveLength(1);
    const p = changed[0]?.payload as {
      junction_marker_id: string;
      position: string;
      confirmed: boolean;
    };
    // switch_state_changed still carries the logical junction marker id.
    expect(p.junction_marker_id).toBe('M-jct-1');
    expect(p.position).toBe('main');
    expect(p.confirmed).toBe(true);
  });

  it('despawnSwitch emits device_disconnected and stops dispatching commands', () => {
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    sim.spawnSwitch('SWITCH-jct-1', 'M-jct-1');
    sim.despawnSwitch('SWITCH-jct-1');
    const disconnects = sim.getEventsOfType('device_disconnected');
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]?.device_id).toBe('SWITCH-jct-1');

    // Commands after despawn should be silently ignored (no switch_state_changed).
    sim.handleCommand('SWITCH-jct-1', 'set_switch_position', { position: 'divert' });
    expect(sim.getEventsOfType('switch_state_changed')).toHaveLength(0);
  });

  it('despawnSwitch on an unknown id is a no-op', () => {
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    // Should not throw.
    sim.despawnSwitch('no-such-switch');
    expect(sim.getEventsOfType('device_disconnected')).toHaveLength(0);
  });

  it('switch events are forwarded to onEvent listeners via the bridge', () => {
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    const captured: string[] = [];
    sim.onEvent((e) => captured.push(e.event_type));
    sim.spawnSwitch('SWITCH-jct-1', 'M-jct-1');
    sim.handleCommand('SWITCH-jct-1', 'set_switch_position', { position: 'divert' });
    expect(captured).toEqual(['device_registered', 'switch_state_changed']);
  });

  it('does not spy on VirtualSwitch (covers acceptCommand via handleCommand)', () => {
    // Belt-and-suspenders: ensure the spy-free path through handleCommand
    // still reaches the switch. Covered by the routing test above; this
    // documents intent that no internal fields are inspected.
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    const sw = sim.spawnSwitch('SWITCH-jct-2', 'M-jct-2');
    // sw is a real VirtualSwitch — no mocking.
    expect(sw).toBeInstanceOf(VirtualSwitch);
    sim.handleCommand('SWITCH-jct-2', 'set_switch_position', { position: 'main' });
    const changed = sim.getEventsOfType('switch_state_changed');
    expect(changed).toHaveLength(1);
  });

  it('spy-less: confirms VirtualSwitch is exported and constructable', () => {
    const events: unknown[] = [];
    const sw = new VirtualSwitch('SWITCH-test', 'M-test', (e) => events.push(e));
    sw.register();
    expect(events).toHaveLength(1);
  });
});

describe('Simulation.handleCommand — no switch registered', () => {
  it('silently ignores set_switch_position when no switch is spawned', () => {
    const sim = new Simulation({
      layout: { name: 'test', markers: [], edges: [], junctions: [] },
      seed: 1,
    });
    // No throw, no switch_state_changed.
    sim.handleCommand('M-nonexistent', 'set_switch_position', { position: 'main' });
    expect(sim.getEventsOfType('switch_state_changed')).toHaveLength(0);
  });
});

describe('VirtualSwitch — position state (turntables and other N-way decks)', () => {
  it('tracks the last confirmed position; undefined before the first set', () => {
    const events: Array<{ event_type: string; payload: unknown }> = [];
    const sw = new VirtualSwitch('SWITCH-tt-1', 'M-tt-1', (e) => events.push(e));
    expect(sw.getPosition()).toBeUndefined();

    // A physical act (a hand-spun deck) and a wire command confirm identically.
    sw.setPosition('stub-b');
    expect(sw.getPosition()).toBe('stub-b');
    const ev = events[0];
    expect(ev?.event_type).toBe('switch_state_changed');
    const p = ev?.payload as { junction_marker_id: string; position: string; confirmed: boolean };
    expect(p).toEqual({ junction_marker_id: 'M-tt-1', position: 'stub-b', confirmed: true });

    sw.acceptCommand('set_switch_position', { position: 'stub-c' });
    expect(sw.getPosition()).toBe('stub-c');
  });

  it('Simulation.getSwitch exposes the spawned motor; unknown ids are undefined', () => {
    const sim = new Simulation({
      layout: { name: 'test', markers: [], edges: [], junctions: [] },
      seed: 1,
    });
    const sw = sim.spawnSwitch('SWITCH-tt-1', 'M-tt-1');
    expect(sim.getSwitch('SWITCH-tt-1')).toBe(sw);
    expect(sim.getSwitch('SWITCH-nope')).toBeUndefined();
  });
});
