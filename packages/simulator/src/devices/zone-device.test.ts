/**
 * Unit tests for the generic capacity-zone device, driven through the REAL
 * in-process bus (`inProcessPlatform`, not a mock). A zone touches no world, so
 * there is none here — we assert its asserted occupancy (the only thing core sees)
 * is published as `zone_state_changed`, and that a length reconciliation emits
 * `train_length_changed`. The full hold-then-admit round-trip is the integrator's
 * gate (the scheduler honours the occupancy); this proves the device's emissions.
 */
import type { CoreEvent } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';
import { ZoneDevice } from './zone-device.js';

const UUID = '44444444-4444-4444-8444-444444444444';
const TS = '1970-01-01T00:00:00.000Z';

interface ZonePayload {
  zone_marker_id: string;
  capacity: number;
  occupancy: number;
}

function rig(initialOccupancy = 0) {
  const bus = new InProcessBus();
  const device = new ZoneDevice('YARD-1', {
    platform: inProcessPlatform(bus, 'YARD-1'),
    zoneMarker: 'M3',
    capacity: 2,
    initialOccupancy,
    newId: () => UUID,
    now: () => TS,
  });
  const events: CoreEvent[] = [];
  bus.onEvent('YARD-1', (e) => events.push(e));
  device.start();
  return { device, events };
}

const zoneStates = (events: CoreEvent[]): ZonePayload[] =>
  events
    .filter((e) => e.event_type === 'zone_state_changed')
    .map((e) => e.payload as unknown as ZonePayload);

describe('ZoneDevice — registration + occupancy', () => {
  it('registers core.gates_zone + core.reports_length and asserts initial occupancy', () => {
    const r = rig(2);
    const reg = r.events.find((e) => e.event_type === 'device_registered');
    const caps = (reg?.payload as unknown as { capabilities: string[] }).capabilities;
    expect(caps).toEqual(expect.arrayContaining(['core.gates_zone', 'core.reports_length']));
    expect(zoneStates(r.events)).toEqual([{ zone_marker_id: 'M3', capacity: 2, occupancy: 2 }]);
  });

  it('fill / vacate / setOccupancy each emit one zone_state_changed on a real change', () => {
    const r = rig(0);
    r.device.fill(); // 0 -> 2
    r.device.vacate(); // 2 -> 1
    r.device.setOccupancy(1); // no change — no event
    r.device.setOccupancy(0); // 1 -> 0
    expect(zoneStates(r.events).map((z) => z.occupancy)).toEqual([0, 2, 1, 0]);
  });

  it('clamps occupancy to [0, capacity]', () => {
    const r = rig(0);
    r.device.setOccupancy(5); // clamps to 2
    r.device.setOccupancy(-3); // clamps to 0
    expect(zoneStates(r.events).map((z) => z.occupancy)).toEqual([0, 2, 0]);
  });
});

describe('ZoneDevice — length reconciliation (core.reports_length)', () => {
  it('reportLength emits train_length_changed with the asserted length', () => {
    const r = rig(0);
    r.device.reportLength('T1', 100);
    const len = r.events.find((e) => e.event_type === 'train_length_changed');
    expect(len?.payload).toEqual({ train_id: 'T1', train_length_mm: 100 });
  });
});
