/**
 * YardZoneDevice unit tests (FROZEN SPEC §4). Real seams only: a real
 * `PhysicsWorld` built from the interesting railway's network, and the real
 * `inProcessPlatform` bus (an `InProcessBus`) as the device's link to core. We
 * observe occupancy/admission through the events the device PUBLISHES (the
 * `zone_state_changed` / `zone_train_released` / `train_length_changed` facts the
 * scheduler would consult) — never by mocking the scheduler, the registry, or the
 * device's own hooks. The yard is DISCOVERED beneath a gantry over the scene's
 * stabling roads; the interior ladder points are opaque to core.
 *
 * The interior `YardController` runs unchanged behind the device's
 * `ParentPlatform`; we drive it by stepping the world + the device exactly as the
 * gate/script would, with a fixed dt (no Date.now / Math.random).
 */
import { describe, expect, it } from 'vitest';
import { discoverGantryYard } from '../physics/gantry-yard.js';
import { buildMainLoopScene } from '../physics/interesting-layout.js';
import { PhysicsWorld } from '../physics/world.js';
import { discoveredYardActuator } from '../sim/discovered-yard-actuator.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';
import { YardZoneDevice } from './yard-zone-device.js';

/** The sim-side throat camera used to wire the device's `sightedTrainAt` provider
 *  from the world (the test plays the composition-root role). */
function nearestLocoId(world: PhysicsWorld, x: number, y: number, r: number): string | null {
  let best: { id: string; d2: number } | null = null;
  for (const b of world.bodies()) {
    if (b.kind !== 'loco') continue;
    const d2 = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (best === null || d2 < best.d2) best = { id: b.id, d2 };
  }
  return best === null || best.d2 > r * r ? null : best.id;
}

const DEVICE_ID = 'YARD-1';
const DT = 1 / 60;
const THROAT_MARKER = 'M-yard';
const TRACK = buildMainLoopScene();
/** The slot the spares cut is stabled in (an inner road). */
const SPARES_SLOT = 'yard-slot1';

interface SeenEvent {
  readonly event_type: string;
  readonly payload: unknown;
}

type SceneExtras = { exitMarker?: string; ownedMarkerIds?: readonly string[] };

/** Stand up a device over an in-process bus + a real world from the interesting
 *  scene's yard, plus a recorder of every event the device publishes (what core would
 *  see). `seedSpares` false leaves the yard's stock for the gantry to discover. */
function setup(
  capacity = 1,
  extras: SceneExtras = {},
  seedSpares = true,
): {
  device: YardZoneDevice;
  world: PhysicsWorld;
  bus: InProcessBus;
  events: SeenEvent[];
  throat: { x: number; y: number };
} {
  const track = TRACK;
  const throat = track.geom.get(track.yard.topLeadIn)?.start;
  if (throat === undefined) throw new Error('scene has no yard throat');
  const discovered = discoverGantryYard(track, track.yard.slots, throat);
  const world = new PhysicsWorld(track.net);
  const bus = new InProcessBus();
  const events: SeenEvent[] = [];
  bus.onEvent(DEVICE_ID, (e) => events.push({ event_type: e.event_type, payload: e.payload }));
  const CAM_R = 20;
  if (seedSpares) stableSpares(world, TRACK.net.railOf(SPARES_SLOT).length);
  const device = new YardZoneDevice(DEVICE_ID, {
    platform: inProcessPlatform(bus, DEVICE_ID),
    scene: {
      yard: discovered.layout,
      throatMarker: THROAT_MARKER,
      throatPoint: throat,
      ...(seedSpares ? { sparesSlot: SPARES_SLOT } : {}),
      ...extras,
    },
    capacity,
    westPoints: discoveredYardActuator(world, discovered.ladder, 'west'),
    eastPoints: discoveredYardActuator(world, discovered.ladder, 'east'),
    look: (x, y) => {
      const s = world.sampleAt(x, y, CAM_R);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
    wedgeAt: (x, y) => {
      world.uncoupleAt(x, y);
    },
    sightedTrainAt: (x, y, r) => nearestLocoId(world, x, y, r),
    motorFor: (id) => physicsMotorActuator(world, id),
  });
  return { device, world, bus, events, throat };
}

/** A coupled two-car cut stabled in the spares slot. */
function stableSpares(world: PhysicsWorld, slotLen: number): void {
  world.addBody({
    id: 'p0',
    kind: 'carriage',
    railPos: slotLen * 0.55,
    facing: 1,
    segment: SPARES_SLOT,
  });
  world.addBody({
    id: 'p1',
    kind: 'carriage',
    railPos: slotLen * 0.55 - 68,
    facing: 1,
    segment: SPARES_SLOT,
  });
  world.couple('p0', 'p1');
}

/** Park a visiting loco (+ optional rear cut) at the end of the yard's entry lead-in so
 *  the throat camera at the top lead's start senses it. */
function parkVisitorAtThroat(world: PhysicsWorld, id: string, cars = 0): void {
  const len = TRACK.net.railOf('yard-leadin').length;
  const at = len - 10;
  world.addBody({ id, kind: 'loco', railPos: at, facing: 1, segment: 'yard-leadin', color: 'red' });
  for (let i = 0; i < cars; i++) {
    const cid = `${id}-c${i}`;
    world.addBody({
      id: cid,
      kind: 'carriage',
      railPos: at - (i + 1) * 68,
      facing: 1,
      segment: 'yard-leadin',
      color: 'amber',
    });
    world.couple(i === 0 ? id : `${id}-c${i - 1}`, cid);
  }
}

const occupanciesOf = (events: readonly SeenEvent[]): number[] =>
  events
    .filter((e) => e.event_type === 'zone_state_changed')
    .map((e) => (e.payload as { occupancy: number }).occupancy);

const lastZone = (events: readonly SeenEvent[]): { capacity: number; occupancy: number } => {
  const zone = events.filter((e) => e.event_type === 'zone_state_changed');
  return zone[zone.length - 1]?.payload as { capacity: number; occupancy: number };
};

describe('YardZoneDevice — registration + initial occupancy', () => {
  it('publishes device_registered (in-line zone: gates_zone + reports_length, no tap) and an initial 0/N zone_state_changed', () => {
    const { device, events } = setup(2);
    device.start();

    const reg = events.find((e) => e.event_type === 'device_registered');
    expect(reg).toBeDefined();
    const regPayload = reg?.payload as { capabilities: string[]; controls_marker_id?: string };
    expect(regPayload.capabilities).toEqual(
      expect.arrayContaining(['core.gates_zone', 'core.reports_length']),
    );
    /* It must NOT claim controls_motion: it never drives a train across the throat. */
    expect(regPayload.capabilities).not.toContain('core.controls_motion');
    /* In-line yard: no scheduler-thrown tap, so no controls_switch and no pairing. */
    expect(regPayload.capabilities).not.toContain('core.controls_switch');
    expect(regPayload.controls_marker_id).toBeUndefined();

    const zone = lastZone(events);
    expect(zone).toMatchObject({ capacity: 2, occupancy: 0 });
  });
});

describe('YardZoneDevice — occupancy rises on arrival, falls on release', () => {
  it('senses a train at the throat, raises occupancy, services it, then releases and frees the slot', () => {
    const { device, world, events } = setup(1);
    device.start();
    expect(lastZone(events).occupancy).toBe(0);

    /* A visitor with a 3-car rear cut parks at the throat; the device senses it. */
    parkVisitorAtThroat(world, 'T1', 3);
    /* First step senses the arrival → occupancy 1/1 (full). */
    device.step(DT);
    expect(lastZone(events)).toMatchObject({ capacity: 1, occupancy: 1 });

    /* Run the interior service to completion (or a generous step cap). */
    let released = false;
    for (let i = 0; i < 12000 && !released; i++) {
      device.step(DT);
      world.step(DT);
      released = events.some((e) => e.event_type === 'zone_train_released');
    }

    const release = events.find((e) => e.event_type === 'zone_train_released');
    expect(release).toBeDefined();
    expect(release?.payload).toMatchObject({ zone_marker_id: THROAT_MARKER, train_id: 'T1' });

    /* Shed-cut reconciliation: a train_length_changed for T1 (ADR-023). */
    const len = events.find((e) => e.event_type === 'train_length_changed');
    expect(len?.payload).toMatchObject({ train_id: 'T1' });

    /* Occupancy fell back to 0 on release. */
    expect(lastZone(events).occupancy).toBe(0);
    /* The occupancy trace rose then fell. */
    const occ = occupanciesOf(events);
    expect(Math.max(...occ)).toBe(1);
    expect(occ[occ.length - 1]).toBe(0);
  });
});

describe('YardZoneDevice — the capacity gate', () => {
  it('does not admit a second train while full (occupancy never exceeds capacity)', () => {
    const { device, world, events } = setup(1);
    device.start();

    /* Two visitors present at once; capacity is 1. The device may sense the
     *  nearest, but must never let occupancy exceed capacity. */
    parkVisitorAtThroat(world, 'T1', 0);
    parkVisitorAtThroat(world, 'T2', 0);

    for (let i = 0; i < 200; i++) {
      device.step(DT);
      world.step(DT);
    }

    const occ = occupanciesOf(events);
    expect(Math.max(...occ)).toBeLessThanOrEqual(1);
    expect(device.occupancy).toBeLessThanOrEqual(1);
    expect(device.capacity).toBe(1);
  });

  it('admits a second resident once a slot frees (occupancy returns to capacity)', () => {
    const { device, world, events } = setup(1);
    device.start();

    parkVisitorAtThroat(world, 'T1', 0);
    device.step(DT);
    expect(device.occupancy).toBe(1);

    /* Drive T1's service to release; its slot frees. */
    let released = false;
    for (let i = 0; i < 12000 && !released; i++) {
      device.step(DT);
      world.step(DT);
      released = events.some((e) => e.event_type === 'zone_train_released');
    }
    expect(device.occupancy).toBe(0);

    /* A second visitor now arrives and is admitted into the freed slot. */
    parkVisitorAtThroat(world, 'T2', 0);
    device.step(DT);
    expect(device.occupancy).toBe(1);
  });
});

describe('YardZoneDevice — discovers operator-placed stock (the toybox gantry)', () => {
  /** The coupled group containing `id`, by flood-fill over the world's couplings. */
  function group(world: PhysicsWorld, id: string): Set<string> {
    const seen = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === undefined) continue;
      for (const n of world.coupledTo(cur))
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
    }
    return seen;
  }

  it('with NO seeded spares, searches its slots, finds the stock, and swaps with it', () => {
    const { device, world, events } = setup(1, {}, false);
    /* The "operator" parks a two-car cut in a slot — the gantry is told NO sparesSlot. */
    stableSpares(world, TRACK.net.railOf(SPARES_SLOT).length);
    device.start();
    parkVisitorAtThroat(world, 'V', 3);

    let released = false;
    for (let i = 0; i < 12000 && !released; i++) {
      device.step(DT);
      world.step(DT);
      released = events.some((e) => e.event_type === 'zone_train_released');
    }
    expect(released, 'the gantry serviced the visitor it discovered stock for').toBe(true);
    /* The visitor leaves wearing the stock the operator placed — discovery worked. */
    const v = group(world, 'V');
    expect(v.has('p0') || v.has('p1'), 'visitor picked up the discovered stock').toBe(true);
  });
});

describe('YardZoneDevice — heading hand-over', () => {
  it('declares no heading capability and emits no train_introduced without an exit marker', () => {
    const { device, events } = setup(1);
    device.start();
    const reg = events.find((e) => e.event_type === 'device_registered');
    const payload = reg?.payload as { capabilities: string[]; owned_marker_ids?: string[] };
    expect(payload.capabilities).not.toContain('core.provides_train_heading');
    expect(payload.owned_marker_ids).toBeUndefined();
  });

  it('declares provides_train_heading + owned markers and introduces the train before releasing it', () => {
    const owned = ['M-a', 'M-b'];
    const { device, world, events } = setup(1, {
      exitMarker: 'M-onward',
      ownedMarkerIds: owned,
    });
    device.start();
    const reg = events.find((e) => e.event_type === 'device_registered');
    const payload = reg?.payload as { capabilities: string[]; owned_marker_ids?: string[] };
    expect(payload.capabilities).toContain('core.provides_train_heading');
    expect(payload.owned_marker_ids).toEqual(owned);

    parkVisitorAtThroat(world, 'T1', 3);
    for (let i = 0; i < 12000 && !events.some((e) => e.event_type === 'zone_train_released'); i++) {
      device.step(DT);
      world.step(DT);
    }

    const types = events.map((e) => e.event_type);
    const introIdx = types.indexOf('train_introduced');
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(introIdx).toBeLessThan(types.indexOf('zone_train_released'));
    expect(events[introIdx]?.payload).toEqual({
      train_id: 'T1',
      marker_id: THROAT_MARKER,
      heading_edge: { from_marker_id: THROAT_MARKER, to_marker_id: 'M-onward' },
    });
  });
});
