import type { CoreCommand, CoreEvent, ZoneStateChanged } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { type DepotLayout, buildDepotLayout } from '../physics/depot.js';

/** Discriminate a zone report off the seam by its event_type literal (sound; the
 *  payload shape follows from the type at runtime). */
function isZoneStateChanged(e: CoreEvent): e is ZoneStateChanged {
  return e.event_type === 'zone_state_changed';
}
import { PhysicsWorld } from '../physics/world.js';
import { DepotController } from './depot-controller.js';
import { physicsMotorActuator } from './motor-actuator.js';
import { physicsSwitchActuator } from './switch-actuator.js';
import { TrainDevice } from './train-device.js';
import { TurntableActuator } from './turntable-actuator.js';

const CAM_R = 22;
const DT = 1 / 60;

/** Wire a depot: a physics world over the depot network, a turntable deck actuator
 *  the depot owns (the interior sub-device), and the controller. Returns the lot
 *  plus a stepper that advances both the controller and the world (sharing the
 *  deck's live angle with the rotating deck rail, exactly as the view does). */
function makeDepot(): {
  layout: DepotLayout;
  world: PhysicsWorld;
  ctrl: DepotController;
  /** Add a visiting loco on the entry lead and return its TrainDevice. */
  addLoco: (id: string, color: string, railPos?: number) => TrainDevice;
  step: () => void;
  poseOf: (id: string) => ReturnType<PhysicsWorld['bodies']>[number] | undefined;
} {
  const layout = buildDepotLayout();
  const world = new PhysicsWorld(layout.net);
  const deck = new TurntableActuator({
    exits: [
      { position: layout.entryPosition, angleDeg: 0 },
      ...layout.stalls.map((s) => ({ position: s.id, angleDeg: s.angleDeg })),
    ],
    switchId: layout.switchId,
    points: physicsSwitchActuator(world, layout.switchId),
    limits: { minDeg: -90, maxDeg: 360 },
    startDeg: 0,
  });
  const ctrl = new DepotController({
    layout,
    deck,
    look: (x, y) => {
      const s = world.sampleAt(x, y, CAM_R);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
  });
  return {
    layout,
    world,
    ctrl,
    addLoco: (id, color, railPos = 200) => {
      world.addBody({
        id,
        kind: 'loco',
        railPos,
        facing: 1,
        segment: 'entry',
        color,
        power: 280,
        maxSpeed: 110,
      });
      return new TrainDevice(id, physicsMotorActuator(world, id));
    },
    step: () => {
      ctrl.tick(DT);
      layout.deckAngle.deg = deck.pos;
      world.step(DT);
    },
    poseOf: (id) => world.bodies().find((b) => b.id === id),
  };
}

/** Run until a predicate holds or a step cap is hit. */
function runUntil(step: () => void, pred: () => boolean, maxSteps = 8000): boolean {
  for (let i = 0; i < maxSteps; i++) {
    if (pred()) return true;
    step();
  }
  return pred();
}

describe('DepotController — a nested capacity-N zone around a capacity-1 turntable', () => {
  it('routes a loco onto its assigned FREE stall and parks it there', () => {
    const d = makeDepot();
    const train = d.addLoco('L', '#c0392b');
    const target = d.layout.stalls[1];
    expect(target).toBeDefined();
    if (target === undefined) return;
    d.ctrl.arrive({ train, stallId: target.id });

    const parked = runUntil(d.step, () => d.ctrl.isOccupied(target.id));
    expect(parked).toBe(true);
    /* Let the loco roll the last short stretch to the buffer and come to a dead
     *  stand in the bay (it is sensed parked two-thirds in, still rolling). */
    const halted = runUntil(d.step, () => (d.poseOf('L')?.speed ?? 99) < 5, 1200);

    const loco = d.poseOf('L');
    expect(loco).toBeDefined();
    // It ended on the assigned stall's parking track (routed correctly through the
    // turntable), at rest against the bay buffer, on the rails.
    expect(loco?.segment).toBe(target.stallSeg);
    expect(halted).toBe(true);
    expect(loco?.fate).toBe('on-rail');
  });

  it('rolls the interior up into ONE occupancy = filled stalls / capacity', () => {
    const d = makeDepot();
    expect(d.ctrl.capacity).toBe(d.layout.stalls.length);
    expect(d.ctrl.occupancy).toBe(0); // empty depot

    const train = d.addLoco('L', '#c0392b');
    const target = d.layout.stalls[0];
    if (target === undefined) return;
    d.ctrl.arrive({ train, stallId: target.id });
    runUntil(d.step, () => d.ctrl.occupancy >= 1);

    // One stall filled → the single rolled-up occupancy core sees is 1.
    expect(d.ctrl.occupancy).toBe(1);
    expect(d.ctrl.isOccupied(target.id)).toBe(true);
  });

  it('SERIALISES the turntable: a second loco waits while the deck is busy, then is routed to a DIFFERENT stall', () => {
    const d = makeDepot();
    const first = d.addLoco('A', '#c0392b', 200);
    const second = d.addLoco('B', '#2e6da4', 60);
    const stallA = d.layout.stalls[0];
    const stallB = d.layout.stalls[2];
    if (stallA === undefined || stallB === undefined) return;
    d.ctrl.arrive({ train: first, stallId: stallA.id });
    d.ctrl.arrive({ train: second, stallId: stallB.id });

    /* While the first loco is being serviced (deck busy), the second is held on
     *  the entry lead — it must NOT have boarded the deck. Catch it mid-service. */
    runUntil(d.step, () => d.ctrl.currentPhase === 'route');
    expect(d.ctrl.deckBusy).toBe(true);
    const secondMid = d.poseOf('B');
    expect(secondMid?.segment).toBe('entry'); // still waiting at the throat
    expect(second.motion).toBe('stopped'); // clearance withheld

    /* Run the whole thing out: both end parked on their DISTINCT stalls. */
    const both = runUntil(
      d.step,
      () => d.ctrl.isOccupied(stallA.id) && d.ctrl.isOccupied(stallB.id),
      16000,
    );
    expect(both).toBe(true);
    expect(d.ctrl.occupancy).toBe(2);
    expect(d.poseOf('A')?.segment).toBe(stallA.stallSeg);
    expect(d.poseOf('B')?.segment).toBe(stallB.stallSeg);
    // The two stalls are genuinely different bays.
    expect(stallA.stallSeg).not.toBe(stallB.stallSeg);
  });
});

describe('DepotController — parent-as-core nesting seam (ADR-031 + ADR-032)', () => {
  it('reports the inner turntable occupancy UP and answers clearance DOWN through the platform seam', () => {
    const d = makeDepot();

    /* The turntable child is wired from the depot's own platform provider — to it
     *  the depot IS core. We observe both directions of the seam: the events the
     *  depot publishes up (as the turntable would), and the commands the depot
     *  sends down (clearance for the inner capacity-1 zone). */
    const childProvider = d.ctrl.platformFor();
    const childGot: CoreCommand[] = [];
    childProvider.onCommand((c) => childGot.push(c));
    const parentSaw: CoreEvent[] = [];
    d.ctrl.onTurntableEvent((e) => parentSaw.push(e));

    const train = d.addLoco('L', '#c0392b');
    const target = d.layout.stalls[0];
    if (target === undefined) return;
    d.ctrl.arrive({ train, stallId: target.id });
    runUntil(d.step, () => d.ctrl.isOccupied(target.id));
    /* A couple more ticks so the seam observes the deck FREEING (the free flip is
     *  reported on the tick after `park` releases the deck). */
    d.step();
    d.step();

    /* Upward: the inner zone reported BUSY (occupancy 1) while a loco was on the
     *  deck, then FREE (occupancy 0) once it parked and the deck released. */
    const zoneReports = parentSaw.flatMap((e) => (isZoneStateChanged(e) ? [e.payload] : []));
    const occupancies = zoneReports.map((p) => p.occupancy);
    expect(occupancies).toContain(1);
    expect(occupancies[occupancies.length - 1]).toBe(0);
    /* The capacity the child asserts is 1 — it is a capacity-1 zone. */
    for (const p of zoneReports) expect(p.capacity).toBe(1);

    /* Downward: the depot withheld clearance while busy and granted it when free —
     *  the inner zone's clearance, answered by the parent exactly as core would. */
    const commands = childGot.map((c) => c.command_type);
    expect(commands).toContain('revoke_clearance');
    expect(commands).toContain('grant_clearance');
  });

  it('the seam is edge-triggered: a quiescent depot emits nothing', () => {
    const d = makeDepot();
    const parentSaw: CoreEvent[] = [];
    d.ctrl.onTurntableEvent((e) => parentSaw.push(e));
    /* Tick an empty depot: the deck never goes busy, so no occupancy flip, so the
     *  seam stays silent (no spurious per-tick chatter). */
    for (let i = 0; i < 50; i++) d.step();
    expect(parentSaw).toHaveLength(0);
  });
});
