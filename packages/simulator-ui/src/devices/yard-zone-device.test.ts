/**
 * YardZoneDevice unit tests (FROZEN SPEC §4). Real seams only: a real
 * `PhysicsWorld` built from the branching scene's network, and the real
 * `inProcessPlatform` bus (an `InProcessBus`) as the device's link to core. We
 * observe occupancy/admission through the events the device PUBLISHES (the
 * `zone_state_changed` / `zone_train_released` / `train_length_changed` facts the
 * scheduler would consult) — never by mocking the scheduler, the registry, or the
 * device's own hooks. The yard is IN-LINE on the running line (a pure zone), so it
 * owns no scheduler-thrown tap; the interior `Jw`/`Je` ladder points are opaque.
 *
 * The interior `YardController` runs unchanged behind the device's
 * `ParentPlatform`; we drive it by stepping the world + the device exactly as the
 * gate/script would, with a fixed dt (no Date.now / Math.random).
 */
import { describe, expect, it } from 'vitest';
import { buildBranchingScene } from '../physics/branching-scene.js';
import { PhysicsWorld } from '../physics/world.js';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';
import { YardZoneDevice } from './yard-zone-device.js';

const DEVICE_ID = 'YARD-1';
const DT = 1 / 60;

interface SeenEvent {
  readonly event_type: string;
  readonly payload: unknown;
}

/** Stand up a device over an in-process bus + a real world from the scene, plus a
 *  recorder of every event the device publishes (what core would see). */
function setup(
  capacity = 1,
  slotCount = 3,
): {
  device: YardZoneDevice;
  world: PhysicsWorld;
  bus: InProcessBus;
  events: SeenEvent[];
  scene: ReturnType<typeof buildBranchingScene>;
} {
  const scene = buildBranchingScene(slotCount);
  const world = new PhysicsWorld(scene.net);
  const bus = new InProcessBus();
  const events: SeenEvent[] = [];
  bus.onEvent(DEVICE_ID, (e) => events.push({ event_type: e.event_type, payload: e.payload }));
  const device = new YardZoneDevice(DEVICE_ID, {
    platform: inProcessPlatform(bus, DEVICE_ID),
    world,
    scene,
    capacity,
  });
  return { device, world, bus, events, scene };
}

/** Park a visiting loco (+ optional rear cut) at the yard's west throat so the
 *  device's camera senses it. The throat is `leadW`'s start (x≈150). */
function parkVisitorAtThroat(world: PhysicsWorld, id: string, cars = 0): void {
  world.addBody({ id, kind: 'loco', railPos: 30, facing: 1, segment: 'leadW', color: 'red' });
  for (let i = 0; i < cars; i++) {
    const cid = `${id}-c${i}`;
    world.addBody({
      id: cid,
      kind: 'carriage',
      railPos: 30 - (i + 1) * 68,
      facing: 1,
      segment: 'leadW',
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
    const { device, world, events, scene } = setup(1);
    device.start();
    expect(lastZone(events).occupancy).toBe(0);

    /* A visitor with a 3-car rear cut parks at the throat; the device senses it. */
    parkVisitorAtThroat(world, 'T1', 3);
    /* Spares already in the yard's spares slot, coupled, so the controller has a
     *  cut to migrate to (mirrors yard-controller.test.ts). */
    const sparesSlot = scene.sparesSlot;
    world.addBody({ id: 'p0', kind: 'carriage', railPos: 200, facing: 1, segment: sparesSlot });
    world.addBody({ id: 'p1', kind: 'carriage', railPos: 132, facing: 1, segment: sparesSlot });
    world.couple('p0', 'p1');

    /* First step senses the arrival → occupancy 1/1 (full). */
    device.step(DT);
    expect(lastZone(events)).toMatchObject({ capacity: 1, occupancy: 1 });

    /* Run the interior service to completion (or a generous step cap). */
    let released = false;
    for (let i = 0; i < 6000 && !released; i++) {
      device.step(DT);
      world.step(DT);
      released = events.some((e) => e.event_type === 'zone_train_released');
    }

    const release = events.find((e) => e.event_type === 'zone_train_released');
    expect(release).toBeDefined();
    expect(release?.payload).toMatchObject({ zone_marker_id: 'M-yard-throat', train_id: 'T1' });

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
    for (let i = 0; i < 6000 && !released; i++) {
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
