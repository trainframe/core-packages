/**
 * Unit tests for the generic operator clearance-gate, driven through the REAL
 * in-process bus (`inProcessPlatform`, not a mock). A gate touches no world, so
 * there is none here — we drive it two ways (the `hold()`/`release()` operator
 * methods and `hold_gate`/`release_gate` override commands) and observe the
 * `gate_state_changed` events it emits. The full hold-the-train round-trip is the
 * integrator's gate (the scheduler honours the withhold); this proves the device
 * tracks its withheld set and emits one transition per real change.
 */
import { type CoreCommand, type CoreEvent, PROTOCOL_VERSION } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { GateDevice } from './gate-device.js';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';

const VERSION = PROTOCOL_VERSION;
const UUID = '33333333-3333-4333-8333-333333333333';
const TS = '1970-01-01T00:00:00.000Z';

function holdGate(markerId: string, reason?: string): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'GATE-1',
    timestamp_server: TS,
    command_type: 'hold_gate',
    protocol_version: VERSION,
    payload: { marker_id: markerId, ...(reason === undefined ? {} : { reason }) },
  };
}

function releaseGate(markerId: string): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'GATE-1',
    timestamp_server: TS,
    command_type: 'release_gate',
    protocol_version: VERSION,
    payload: { marker_id: markerId },
  };
}

interface GatePayload {
  marker_id: string;
  state: 'withholding' | 'granting';
  reason?: string;
}

interface Rig {
  readonly device: GateDevice;
  readonly events: CoreEvent[];
  send(command: CoreCommand): void;
}

function rig(opts?: { markers?: string[]; initialWithheld?: string[] }): Rig {
  const bus = new InProcessBus();
  const platform = inProcessPlatform(bus, 'GATE-1');
  const device = new GateDevice('GATE-1', {
    platform,
    markers: opts?.markers ?? ['M3'],
    ...(opts?.initialWithheld === undefined ? {} : { initialWithheld: opts.initialWithheld }),
    newId: () => UUID,
    now: () => TS,
  });
  const events: CoreEvent[] = [];
  bus.onEvent('GATE-1', (e) => events.push(e));
  device.start();
  return { device, events, send: (c) => bus.sendCommand('GATE-1', c) };
}

const gateEvents = (events: CoreEvent[]): GatePayload[] =>
  events
    .filter((e) => e.event_type === 'gate_state_changed')
    .map((e) => e.payload as unknown as GatePayload);

describe('GateDevice — registration', () => {
  it('registers core.gates_clearance', () => {
    const reg = rig().events.find((e) => e.event_type === 'device_registered');
    const payload = reg?.payload as unknown as { capabilities: string[] };
    expect(payload.capabilities).toContain('core.gates_clearance');
  });

  it('emits an initial withhold for a gate that starts closed', () => {
    const r = rig({ markers: ['M3'], initialWithheld: ['M3'] });
    expect(gateEvents(r.events)).toEqual([
      { marker_id: 'M3', state: 'withholding', reason: 'closed' },
    ]);
  });
});

describe('GateDevice — operator hold/release methods', () => {
  it('holding then releasing emits one withholding and one granting', () => {
    const r = rig();
    r.device.hold('M3', 'operator');
    r.device.release('M3');
    expect(gateEvents(r.events)).toEqual([
      { marker_id: 'M3', state: 'withholding', reason: 'operator' },
      { marker_id: 'M3', state: 'granting' },
    ]);
  });

  it('is idempotent — a second hold (or release) emits nothing', () => {
    const r = rig();
    r.device.hold('M3');
    r.device.hold('M3');
    r.device.release('M3');
    r.device.release('M3');
    expect(gateEvents(r.events)).toHaveLength(2);
  });

  it('refuses to gate a marker it does not own', () => {
    const r = rig({ markers: ['M3'] });
    r.device.hold('M7');
    expect(gateEvents(r.events)).toHaveLength(0);
  });
});

describe('GateDevice — server override commands', () => {
  it('hold_gate / release_gate drive the same withheld set', () => {
    const r = rig();
    r.send(holdGate('M3', 'maintenance'));
    r.send(releaseGate('M3'));
    expect(gateEvents(r.events)).toEqual([
      { marker_id: 'M3', state: 'withholding', reason: 'maintenance' },
      { marker_id: 'M3', state: 'granting' },
    ]);
  });

  it('stops obeying commands after stop()', () => {
    const r = rig();
    r.device.stop();
    r.send(holdGate('M3'));
    expect(gateEvents(r.events)).toHaveLength(0);
  });
});
