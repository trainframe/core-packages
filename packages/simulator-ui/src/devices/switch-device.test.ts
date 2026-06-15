/**
 * Unit tests for the main-line switch device, driven through the REAL in-process
 * bus (`inProcessPlatform`, not a mock) against a REAL `PhysicsWorld` switch
 * table. We publish `set_switch_position` commands and observe both the world's
 * switch state (the actuator's effect) and the `switch_state_changed` confirmation
 * the device emits. No scheduler here — the integrator's gate proves the full
 * pairing; this proves the device throws the points and confirms.
 */
import { type CoreCommand, type CoreEvent, PROTOCOL_VERSION } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { buildNetwork } from '../physics/network.js';
import type { Rail } from '../physics/rail.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsSwitchActuator } from '../sim/switch-actuator.js';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';
import { SwitchDevice } from './switch-device.js';

const VERSION = PROTOCOL_VERSION;
const UUID = '22222222-2222-4222-8222-222222222222';
const TS = '1970-01-01T00:00:00.000Z';

function straightRail(length: number): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

function setSwitch(junctionMarkerId: string, position: string): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'SW-spur',
    timestamp_server: TS,
    command_type: 'set_switch_position',
    protocol_version: VERSION,
    payload: { junction_marker_id: junctionMarkerId, position },
  };
}

interface Rig {
  events: CoreEvent[];
  send(command: CoreCommand): void;
  switchPosition(): string | undefined;
}

function rig(): Rig {
  const bus = new InProcessBus();
  const platform = inProcessPlatform(bus, 'SW-spur');
  const net = buildNetwork(new Map([['main', straightRail(100)]]), []);
  const w = new PhysicsWorld(net);
  /* Expose the world's switch table via a probe link: the actuator writes the
   *  position the network would read. We read it back through a spy actuator. */
  let lastPosition: string | undefined;
  const realActuator = physicsSwitchActuator(w, 'Jspur');
  const actuator = {
    set(position: string): void {
      lastPosition = position;
      realActuator.set(position);
    },
  };
  const device = new SwitchDevice('SW-spur', {
    platform,
    actuator,
    junctionMarkerId: 'M-spur',
    positions: ['thru', 'branch'],
    newId: () => UUID,
    now: () => TS,
  });
  const events: CoreEvent[] = [];
  bus.onEvent('SW-spur', (e) => events.push(e));
  device.start();
  return {
    events,
    send: (c) => bus.sendCommand('SW-spur', c),
    switchPosition: () => lastPosition,
  };
}

const confirms = (events: CoreEvent[]): CoreEvent[] =>
  events.filter((e) => e.event_type === 'switch_state_changed');

describe('SwitchDevice — registration', () => {
  it('registers core.controls_switch paired to its junction marker', () => {
    const r = rig();
    const reg = r.events.find((e) => e.event_type === 'device_registered');
    const payload = reg?.payload as unknown as {
      capabilities: string[];
      controls_marker_id: string;
    };
    expect(payload.capabilities).toContain('core.controls_switch');
    expect(payload.controls_marker_id).toBe('M-spur');
  });
});

describe('SwitchDevice — throwing the points', () => {
  it('throws the actuator and confirms on a matching set_switch_position', () => {
    const r = rig();
    r.send(setSwitch('M-spur', 'branch'));
    expect(r.switchPosition()).toBe('branch');
    const cs = confirms(r.events);
    expect(cs).toHaveLength(1);
    const payload = cs[0]?.payload as {
      junction_marker_id: string;
      position: string;
      confirmed: boolean;
    };
    expect(payload).toEqual({
      junction_marker_id: 'M-spur',
      position: 'branch',
      confirmed: true,
    });
  });

  it('ignores a command for a different junction', () => {
    const r = rig();
    r.send(setSwitch('M-main-w', 'yard'));
    expect(r.switchPosition()).toBeUndefined();
    expect(confirms(r.events)).toHaveLength(0);
  });

  it('ignores a position not in valid_positions', () => {
    const r = rig();
    r.send(setSwitch('M-spur', 'nonsense'));
    expect(r.switchPosition()).toBeUndefined();
    expect(confirms(r.events)).toHaveLength(0);
  });

  it('stops obeying commands after stop()', () => {
    const bus = new InProcessBus();
    const platform = inProcessPlatform(bus, 'SW-spur');
    const net = buildNetwork(new Map([['main', straightRail(100)]]), []);
    const w = new PhysicsWorld(net);
    const device = new SwitchDevice('SW-spur', {
      platform,
      actuator: physicsSwitchActuator(w, 'Jspur'),
      junctionMarkerId: 'M-spur',
      positions: ['thru', 'branch'],
      newId: () => UUID,
      now: () => TS,
    });
    const events: CoreEvent[] = [];
    bus.onEvent('SW-spur', (e) => events.push(e));
    device.start();
    device.stop();
    bus.sendCommand('SW-spur', setSwitch('M-spur', 'branch'));
    expect(confirms(events)).toHaveLength(0);
  });
});
