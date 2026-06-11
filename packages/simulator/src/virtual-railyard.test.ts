import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';
import { VirtualRailyard } from './virtual-railyard.js';
import type { VirtualCarriage } from './virtual-train.js';

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

  it('register announces the capabilities and the zone initial state', () => {
    const { events, yard } = capture();
    yard('YARD-1', 'M3', 3).register();

    const registered = events.find((e) => e.event_type === 'device_registered');
    expect(registered?.payload).toEqual({
      capabilities: ['core.gates_zone', 'core.reports_length'],
    });

    const zone = zoneEvents(events).at(-1);
    expect(zone?.payload).toEqual({ zone_marker_id: 'M3', capacity: 3, occupancy: 0 });
  });

  it('reportTrainLength emits a train_length_changed for the departing train', () => {
    const { events, yard } = capture();
    const y = yard('YARD-1', 'M3', 2);
    y.register();

    y.reportTrainLength('T1', 120);

    const lengthEvent = events.find((e) => e.event_type === 'train_length_changed');
    expect(lengthEvent?.device_id).toBe('YARD-1');
    expect(lengthEvent?.payload).toEqual({ train_id: 'T1', train_length_mm: 120 });
  });

  it('releaseTrain emits zone_train_released naming the train and the throat', () => {
    const { events, yard } = capture();
    const y = yard('YARD-1', 'M3', 2);
    y.register();

    y.releaseTrain('T1');

    const released = events.find((e) => e.event_type === 'zone_train_released');
    expect(released?.device_id).toBe('YARD-1');
    expect(released?.payload).toEqual({ zone_marker_id: 'M3', train_id: 'T1' });
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

describe('VirtualRailyard carriage swap (the opaque-interior rearrange)', () => {
  const SWAP_LOOP = {
    name: 'swap-loop',
    markers: [
      { id: 'M1', kind: 'block_boundary' as const },
      { id: 'M3', kind: 'yard_entry' as const },
    ],
    edges: [{ from_marker_id: 'M1', to_marker_id: 'M3', estimated_length_mm: 200 }],
    junctions: [],
  };

  const wagon = (id: string, colorId: string): VirtualCarriage => ({ id, colorId });
  const consistIds = (sim: Simulation, trainId: string) =>
    (sim.getTrain(trainId)?.getConsist() ?? []).map((c) => c.id);

  const FLEET = ['T-A', 'T-B', 'T-C'];

  /** Which fleet train currently holds wagon `id` (or 'yard' / 'lost'). */
  const holderOf = (sim: Simulation, yard: VirtualRailyard, id: string): string =>
    FLEET.find((t) => consistIds(sim, t).includes(id)) ??
    (yard.getSpares().some((c) => c.id === id) ? 'yard' : 'lost');

  /** Service the train at `id`, asserting it exists; returns nothing. */
  const visit = (sim: Simulation, yard: VirtualRailyard, id: string): void => {
    const train = sim.getTrain(id);
    if (train === undefined) throw new Error(`no train ${id}`);
    yard.swapLeadingPair(train);
  };

  /** Spawn a train carrying a 4-wagon rake of one livery (e.g. R1..R4). */
  const trainWith = (sim: Simulation, id: string, livery: string) => {
    sim.spawnTrain(id, { startEdge: { from_marker_id: 'M1', to_marker_id: 'M3' } });
    sim.setTrainConsist(
      id,
      [1, 2, 3, 4].map((n) => wagon(`${livery}${n}`, livery)),
    );
  };

  it('swaps the leading pair for the spares and keeps the dropped pair as new spares', () => {
    const sim = new Simulation({ layout: SWAP_LOOP, seed: 1 });
    const yard = sim.spawnRailyard('YARD-1', 'M3', 6);
    yard.loadSpares([wagon('P1', 'purple'), wagon('P2', 'purple')]);
    trainWith(sim, 'T-red', 'R');

    const train = sim.getTrain('T-red');
    if (train === undefined) throw new Error('no train');
    yard.swapLeadingPair(train);

    // The purple spares now lead the rake; the red leading pair was dropped.
    expect(consistIds(sim, 'T-red')).toEqual(['P1', 'P2', 'R3', 'R4']);
    expect(yard.getSpares().map((c) => c.id)).toEqual(['R1', 'R2']);
  });

  it('shunts the leading cut as a timed interior maneuver, not an atomic swap (ADR-029)', () => {
    const sim = new Simulation({ layout: SWAP_LOOP, seed: 1 });
    const yard = sim.spawnRailyard('YARD-1', 'M3', 6);
    yard.loadSpares([wagon('P1', 'purple'), wagon('P2', 'purple')]);
    trainWith(sim, 'T-red', 'R');
    // Drive the train to the yard throat (M3) and let it park there.
    sim.handleCommand('T-red', 'assign_route', {
      route_id: 'in',
      edges: [{ from_marker_id: 'M1', to_marker_id: 'M3' }],
    });
    sim.handleCommand('T-red', 'grant_clearance', { limit_marker_id: 'M3' });

    // Run the sim; the yard pulls the train in, the crane decouples its leading
    // cut, couples the spares, and it returns to the throat. Record the rake
    // length each tick + whether the interior maneuver was ever in progress.
    const lengthsSeen = new Set<number>();
    let sawInteriorMotion = false;
    let craneWorked = false;
    for (let i = 0; i < 400; i++) {
      sim.advance(50);
      lengthsSeen.add(sim.getTrain('T-red')?.getConsist().length ?? 0);
      const interior = yard.getInteriorState();
      if (interior !== null) {
        sawInteriorMotion = true;
        if (interior.droppedCutIds.length > 0) craneWorked = true;
      }
    }

    // The rake passed through a SHORTER state (decoupled) before being made
    // whole — proof it was a timed maneuver, not an instantaneous array swap.
    expect(lengthsSeen.has(2), 'rake briefly shortened (decoupled)').toBe(true);
    expect(lengthsSeen.has(4), 'rake made whole again (coupled)').toBe(true);
    expect(sawInteriorMotion, 'train was driven inside the yard').toBe(true);
    expect(craneWorked, 'crane worked a cut').toBe(true);
    // End state matches the swap: the purple spares now lead, the red pair dropped.
    expect(consistIds(sim, 'T-red')).toEqual(['P1', 'P2', 'R3', 'R4']);
    expect(yard.getSpares().map((c) => c.id)).toEqual(['R1', 'R2']);
  });

  /** Accumulates what a replayed maneuver passed through (ordered phases, the
   *  rake lengths seen, whether a cut was ever lifted/held). */
  interface ShuntTrace {
    phaseOrder: string[];
    lengths: Set<number>;
    sawHeldCut: boolean;
    sawTrailOffset: boolean;
  }

  /** Fold one observed interior tick into the running trace. */
  const recordTick = (
    trace: ShuntTrace,
    interior: NonNullable<ReturnType<VirtualRailyard['getInteriorState']>>,
    rakeLength: number,
  ): void => {
    if (trace.phaseOrder.at(-1) !== interior.phase) trace.phaseOrder.push(interior.phase);
    trace.lengths.add(rakeLength);
    if (interior.droppedCutIds.length > 0) trace.sawHeldCut = true;
    if (interior.trailOffset > 0) trace.sawTrailOffset = true;
  };

  /** Replay a serviced train's interior maneuver, returning its trace. Pure
   *  observation — drives the real sim. */
  const replayShunt = (sim: Simulation, yard: VirtualRailyard, trainId: string): ShuntTrace => {
    const trace: ShuntTrace = {
      phaseOrder: [],
      lengths: new Set(),
      sawHeldCut: false,
      sawTrailOffset: false,
    };
    for (let i = 0; i < 600; i++) {
      sim.advance(50);
      const interior = yard.getInteriorState();
      if (interior !== null) {
        recordTick(trace, interior, sim.getTrain(trainId)?.getConsist().length ?? 0);
      }
    }
    return trace;
  };

  it('drives the on-rail choreography: enter, decouple, pull onto the lead, set into the spares, inspect, leave', () => {
    const sim = new Simulation({ layout: SWAP_LOOP, seed: 1 });
    const yard = sim.spawnRailyard('YARD-1', 'M3', 6);
    yard.loadSpares([wagon('P1', 'purple'), wagon('P2', 'purple')]);
    trainWith(sim, 'T-red', 'R');
    sim.handleCommand('T-red', 'assign_route', {
      route_id: 'in',
      edges: [{ from_marker_id: 'M1', to_marker_id: 'M3' }],
    });
    sim.handleCommand('T-red', 'grant_clearance', { limit_marker_id: 'M3' });

    const { phaseOrder, lengths, sawHeldCut, sawTrailOffset } = replayShunt(sim, yard, 'T-red');

    // Every phase ran, in order: enter the slot, the crane decouples, pull back
    // onto the lead, set into the spares slot, the camera reads it, then it
    // drives back out to the throat.
    expect(phaseOrder).toEqual([
      'enter',
      'decouple',
      'cross-pull',
      'cross-set',
      'inspect',
      'release-out',
    ]);
    // The rake was held SHORTER (a cut lifted off) before being made whole — a
    // timed maneuver, not an instant swap — and the crane held a real cut.
    expect(lengths.has(2), 'rake briefly shortened (cut lifted)').toBe(true);
    expect(lengths.has(4), 'rake made whole again (spares coupled)').toBe(true);
    expect(sawHeldCut, 'crane held a lifted cut').toBe(true);
    expect(sawTrailOffset, 'the remaining rake is held back while a cut is off').toBe(true);
    // End state matches the swap: purple spares now lead, red pair dropped.
    expect(consistIds(sim, 'T-red')).toEqual(['P1', 'P2', 'R3', 'R4']);
    expect(yard.getSpares().map((c) => c.id)).toEqual(['R1', 'R2']);
  });

  it('a train with nothing to swap still enters and is inspected, but the crane lifts no cut', () => {
    const sim = new Simulation({ layout: SWAP_LOOP, seed: 1 });
    // No spares loaded: the yard has nothing to hand back, so it decides not to
    // decouple — but the train still officially enters and is camera-read.
    const yard = sim.spawnRailyard('YARD-1', 'M3', 6);
    trainWith(sim, 'T-red', 'R');
    sim.handleCommand('T-red', 'assign_route', {
      route_id: 'in',
      edges: [{ from_marker_id: 'M1', to_marker_id: 'M3' }],
    });
    sim.handleCommand('T-red', 'grant_clearance', { limit_marker_id: 'M3' });

    const phases = new Set<string>();
    const lengthsSeen = new Set<number>();
    for (let i = 0; i < 600; i++) {
      sim.advance(50);
      const interior = yard.getInteriorState();
      if (interior !== null) phases.add(interior.phase);
      lengthsSeen.add(sim.getTrain('T-red')?.getConsist().length ?? 4);
    }

    expect(phases.has('enter')).toBe(true);
    expect(phases.has('inspect')).toBe(true);
    // It skipped the swap phases entirely — no decouple, no cross moves.
    expect(phases.has('decouple')).toBe(false);
    expect(phases.has('cross-set')).toBe(false);
    // The rake was never shortened — the crane lifted nothing.
    expect(lengthsSeen.has(2)).toBe(false);
    expect(consistIds(sim, 'T-red')).toEqual(['R1', 'R2', 'R3', 'R4']);
  });

  it('is a no-op for a train shorter than the swap pair', () => {
    const sim = new Simulation({ layout: SWAP_LOOP, seed: 1 });
    const yard = sim.spawnRailyard('YARD-1', 'M3', 6);
    yard.loadSpares([wagon('P1', 'purple'), wagon('P2', 'purple')]);
    sim.spawnTrain('T1', { startEdge: { from_marker_id: 'M1', to_marker_id: 'M3' } });
    sim.setTrainConsist('T1', [wagon('X1', 'x')]);

    const train = sim.getTrain('T1');
    if (train === undefined) throw new Error('no train');
    yard.swapLeadingPair(train);

    expect(consistIds(sim, 'T1')).toEqual(['X1']); // untouched
    expect(yard.getSpares().map((c) => c.id)).toEqual(['P1', 'P2']); // spares intact
  });

  it('cycles a wagon across successive trains rather than ping-ponging two', () => {
    // Three trains visiting in rotation: a given wagon only moves when its
    // current holder is revisited, so over enough laps the purple pair must
    // land on EVERY train, not bounce between a fixed two — proof a carriage
    // tours the whole fleet, the headline the demo exists to show.
    const sim = new Simulation({ layout: SWAP_LOOP, seed: 1 });
    const yard = sim.spawnRailyard('YARD-1', 'M3', 6);
    yard.loadSpares([wagon('P1', 'purple'), wagon('P2', 'purple')]);
    trainWith(sim, 'T-A', 'A');
    trainWith(sim, 'T-B', 'B');
    trainWith(sim, 'T-C', 'C');

    // Three full rounds of the rotation (9 visits), tracking where P1 lands.
    const visited = new Set<string>();
    const sequence = [...FLEET, ...FLEET, ...FLEET];
    for (const id of sequence) {
      visit(sim, yard, id);
      visited.add(holderOf(sim, yard, 'P1'));
    }

    // P1 has ridden on all three trains — it is touring the fleet, not bouncing
    // between a fixed pair. And it is never lost in the shuffle.
    expect(FLEET.every((t) => visited.has(t))).toBe(true);
    expect(holderOf(sim, yard, 'P1')).not.toBe('lost');
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
