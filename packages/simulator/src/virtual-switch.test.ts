import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';
import { VirtualSwitch } from './virtual-switch.js';

// ---------------------------------------------------------------------------
// VirtualSwitch unit tests
// ---------------------------------------------------------------------------

describe('VirtualSwitch', () => {
  function makeSwitch(): {
    sw: VirtualSwitch;
    events: Array<{ event_type: string; device_id: string; payload: unknown }>;
  } {
    const events: Array<{ event_type: string; device_id: string; payload: unknown }> = [];
    const sw = new VirtualSwitch('M-jct-1', 'M-jct-1', (e) => events.push(e));
    return { sw, events };
  }

  it('register() emits device_registered with core.controls_switch', () => {
    const { sw, events } = makeSwitch();
    sw.register();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev?.event_type).toBe('device_registered');
    expect(ev?.device_id).toBe('M-jct-1');
    expect((ev?.payload as { capabilities: string[] }).capabilities).toEqual([
      'core.controls_switch',
    ]);
  });

  it('acceptCommand(set_switch_position) emits switch_state_changed with confirmed: true', () => {
    const { sw, events } = makeSwitch();
    sw.register();
    sw.acceptCommand('set_switch_position', { junction_marker_id: 'M-jct-1', position: 'divert' });
    expect(events).toHaveLength(2);
    const ev = events[1];
    expect(ev?.event_type).toBe('switch_state_changed');
    expect(ev?.device_id).toBe('M-jct-1');
    const p = ev?.payload as { junction_marker_id: string; position: string; confirmed: boolean };
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

  it('registers the switch and broadcasts device_registered', () => {
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    sim.spawnSwitch('M-jct-1', 'M-jct-1');
    const regs = sim.getEventsOfType('device_registered');
    expect(regs.length).toBe(1);
    const payload = regs[0]?.payload as { capabilities: string[] };
    expect(payload.capabilities).toEqual(['core.controls_switch']);
  });

  it('routes set_switch_position to the switch and emits switch_state_changed', () => {
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    sim.spawnSwitch('M-jct-1', 'M-jct-1');
    sim.handleCommand('M-jct-1', 'set_switch_position', {
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
    expect(p.junction_marker_id).toBe('M-jct-1');
    expect(p.position).toBe('main');
    expect(p.confirmed).toBe(true);
  });

  it('despawnSwitch emits device_disconnected and stops dispatching commands', () => {
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    sim.spawnSwitch('M-jct-1', 'M-jct-1');
    sim.despawnSwitch('M-jct-1');
    const disconnects = sim.getEventsOfType('device_disconnected');
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]?.device_id).toBe('M-jct-1');

    // Commands after despawn should be silently ignored (no switch_state_changed).
    sim.handleCommand('M-jct-1', 'set_switch_position', { position: 'divert' });
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
    sim.spawnSwitch('M-jct-1', 'M-jct-1');
    sim.handleCommand('M-jct-1', 'set_switch_position', { position: 'divert' });
    expect(captured).toEqual(['device_registered', 'switch_state_changed']);
  });

  it('does not spy on VirtualSwitch (covers acceptCommand via handleCommand)', () => {
    // Belt-and-suspenders: ensure the spy-free path through handleCommand
    // still reaches the switch. Covered by the routing test above; this
    // documents intent that no internal fields are inspected.
    const sim = new Simulation({ layout: EMPTY_LAYOUT, seed: 1 });
    const sw = sim.spawnSwitch('M-jct-2', 'M-jct-2');
    // sw is a real VirtualSwitch — no mocking.
    expect(sw).toBeInstanceOf(VirtualSwitch);
    sim.handleCommand('M-jct-2', 'set_switch_position', { position: 'main' });
    const changed = sim.getEventsOfType('switch_state_changed');
    expect(changed).toHaveLength(1);
  });

  it('spy-less: confirms VirtualSwitch is exported and constructable', () => {
    const events: unknown[] = [];
    const sw = new VirtualSwitch('M-test', 'M-test', (e) => events.push(e));
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
