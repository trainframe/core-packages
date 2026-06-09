import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';
import { VirtualRailyard } from './virtual-railyard.js';

/*
 * Device-mechanics tests for the VirtualRailyard: it asserts capacity +
 * occupancy as zone_state_changed events, the fact the core.gates_zone
 * capability gates admission on (ADR-026). The end-to-end admission gate (a
 * full yard holds a routed train at the throat; a freed slot admits it) is an
 * integration test against a real scheduler in packages/integration.
 */

interface Emitted {
  event_type: string;
  device_id: string;
  payload: unknown;
}

const capture = () => {
  const events: Emitted[] = [];
  const yard = (device_id: string, marker: string, capacity: number) =>
    new VirtualRailyard(device_id, marker, capacity, (e) => events.push(e));
  return { events, yard };
};

const zoneEvents = (events: Emitted[]) =>
  events.filter((e) => e.event_type === 'zone_state_changed');
const lastOccupancy = (events: Emitted[]) =>
  (zoneEvents(events).at(-1)?.payload as { occupancy: number }).occupancy;

describe('VirtualRailyard device mechanics', () => {
  it('rejects a non-integer or negative capacity', () => {
    const { yard } = capture();
    expect(() => yard('YARD', 'M3', -1)).toThrow(/non-negative integer/);
    expect(() => yard('YARD', 'M3', 2.5)).toThrow(/non-negative integer/);
  });

  it('register announces the capability and the zone initial state', () => {
    const { events, yard } = capture();
    yard('YARD-1', 'M3', 3).register();

    const registered = events.find((e) => e.event_type === 'device_registered');
    expect(registered?.payload).toEqual({ capabilities: ['core.gates_zone'] });

    const zone = zoneEvents(events).at(-1);
    expect(zone?.payload).toEqual({ zone_marker_id: 'M3', capacity: 3, occupancy: 0 });
  });

  it('occupy fills the next free slot and asserts the new occupancy', () => {
    const { events, yard } = capture();
    const y = yard('YARD-1', 'M3', 2);
    y.register();

    expect(y.occupy('consist-A')).toBe(0);
    expect(y.occupancy).toBe(1);
    expect(lastOccupancy(events)).toBe(1);

    expect(y.occupy('cut-of-carriages')).toBe(1);
    expect(y.occupancy).toBe(2);
    expect(lastOccupancy(events)).toBe(2);
  });

  it('occupy on a full yard returns -1 and emits nothing further', () => {
    const { events, yard } = capture();
    const y = yard('YARD-1', 'M3', 1);
    y.register();
    y.occupy();
    const before = zoneEvents(events).length;

    expect(y.occupy()).toBe(-1);
    expect(zoneEvents(events).length).toBe(before);
  });

  it('vacate frees a slot and asserts the lower occupancy', () => {
    const { events, yard } = capture();
    const y = yard('YARD-1', 'M3', 2);
    y.register();
    y.fillToCapacity();
    expect(y.occupancy).toBe(2);

    y.vacate();
    expect(y.occupancy).toBe(1);
    expect(lastOccupancy(events)).toBe(1);
  });

  it('vacate is a no-op (no event) for an already-free or out-of-range slot', () => {
    const { events, yard } = capture();
    const y = yard('YARD-1', 'M3', 2);
    y.register();
    const before = zoneEvents(events).length;

    y.vacate(); // nothing occupied
    y.vacate(5); // out of range
    expect(zoneEvents(events).length).toBe(before);
    expect(y.occupancy).toBe(0);
  });

  it('fillToCapacity fills all slots once; a second call is a no-op', () => {
    const { events, yard } = capture();
    const y = yard('YARD-1', 'M3', 3);
    y.register();

    y.fillToCapacity();
    expect(y.occupancy).toBe(3);
    const after = zoneEvents(events).length;

    y.fillToCapacity();
    expect(zoneEvents(events).length).toBe(after);
  });

  it('is scalable: capacity is whatever it was constructed with', () => {
    const { yard } = capture();
    expect(yard('YARD-BIG', 'M3', 12).capacity).toBe(12);
    expect(yard('YARD-ZERO', 'M3', 0).capacity).toBe(0);
  });
});

describe('Simulation.spawnRailyard / despawnRailyard', () => {
  const LOOP = {
    name: 'yard-loop',
    markers: [
      { id: 'M1', kind: 'block_boundary' as const },
      { id: 'M3', kind: 'yard_entry' as const },
    ],
    edges: [{ from_marker_id: 'M1', to_marker_id: 'M3', estimated_length_mm: 200 }],
    junctions: [],
  };

  it('spawn captures device_registered + initial zone_state_changed', () => {
    const sim = new Simulation({ layout: LOOP, seed: 1 });
    const yard = sim.spawnRailyard('YARD-1', 'M3', 2);
    expect(yard.capacity).toBe(2);

    const registered = sim.events.find(
      (e) => e.event_type === 'device_registered' && e.device_id === 'YARD-1',
    );
    expect(registered).toBeDefined();
    const zone = sim.events.find(
      (e) => e.event_type === 'zone_state_changed' && e.device_id === 'YARD-1',
    );
    expect((zone?.payload as { capacity: number }).capacity).toBe(2);
  });

  it('despawn emits device_disconnected', () => {
    const sim = new Simulation({ layout: LOOP, seed: 1 });
    sim.spawnRailyard('YARD-1', 'M3', 2);
    sim.despawnRailyard('YARD-1');
    expect(
      sim.events.some((e) => e.event_type === 'device_disconnected' && e.device_id === 'YARD-1'),
    ).toBe(true);
  });
});
