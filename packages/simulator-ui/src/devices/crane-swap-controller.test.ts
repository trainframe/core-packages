import { describe, expect, it } from 'vitest';
import { PieceNetworkBuilder, type PieceSpec } from '../physics/piece-network.js';
import { addTrapezoidYard } from '../physics/trapezoid-yard.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { craneSwapOps } from '../sim/crane-swap-ops.js';
import { CraneSwapController } from './crane-swap-controller.js';
import { Crane } from './crane.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const DT = 1 / 60;
const RED = '#c0392b';
const GOLD = '#e0a81e';

/** A real-pieces drive-in yard with three sidings: road 0 holds the visiting train
 *  (loco + two cars), road 1 holds the spare cut, road 2 is the empty holding road
 *  the crane drops the shed cut onto. */
function buildYard() {
  const b = new PieceNetworkBuilder();
  const afterLead = b.run('approach', { x: 0, y: 0, dir: 0, layer: 0 }, [
    STRAIGHT,
    STRAIGHT,
    STRAIGHT,
  ]);
  const trap = addTrapezoidYard(b, afterLead, { prefix: 'YD', sidings: 3, sidingStraights: 3 });
  b.link('approach', trap.inbound);
  const built = b.build();
  return { net: built.net, sidings: trap.segments.sidings };
}

/** Crane bounds enclosing every rail point (so it can reach the whole yard). */
function boundsOf(net: ReturnType<typeof buildYard>['net']) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const id of net.segments()) {
    const r = net.railOf(id);
    const n = Math.max(2, Math.ceil(r.length / 30));
    for (let i = 0; i <= n; i++) {
      const p = r.at((r.length * i) / n);
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  return {
    minX: Math.min(...xs) - 50,
    maxX: Math.max(...xs) + 50,
    minY: Math.min(...ys) - 50,
    maxY: Math.max(...ys) + 50,
  };
}

/** The body ids in `id`'s rake, by flood-fill over couplings. */
function rake(world: PhysicsWorld, id: string): Set<string> {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length > 0) {
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

/** Stage the yard with a parked train in road 0 and spares in road 1, the crane
 *  wired to the controller via the sim lift/place ops. Geometry points are read
 *  from the seeded poses — the controller is told only WHERE to reach, never which
 *  bodies are there (it acts purely through the crane + the lift/place callbacks). */
function stage(loop = false) {
  const { net, sidings } = buildYard();
  const world = new PhysicsWorld(net);
  const trainRoad = sidings[0];
  const sparesRoad = sidings[1];
  const holdingRoad = sidings[2];
  if (trainRoad === undefined || sparesRoad === undefined || holdingRoad === undefined) {
    throw new Error('expected three sidings');
  }

  const trainLen = net.railOf(trainRoad).length;
  const sparesLen = net.railOf(sparesRoad).length;
  const holdLen = net.railOf(holdingRoad).length;

  /* Train: loco at the buffer end facing in, two cars trailing back. */
  const locoPos = trainLen - 120;
  world.addBody({
    id: 'T',
    kind: 'loco',
    railPos: locoPos,
    facing: 1,
    segment: trainRoad,
    color: RED,
  });
  for (let i = 0; i < 2; i++) {
    const id = `c${i}`;
    world.addBody({
      id,
      kind: 'carriage',
      railPos: locoPos - (i + 1) * 68,
      facing: 1,
      segment: trainRoad,
      color: RED,
    });
    world.couple(i === 0 ? 'T' : `c${i - 1}`, id);
  }

  /* Spare cut parked in road 1. */
  world.addBody({
    id: 'S0',
    kind: 'carriage',
    railPos: sparesLen - 120,
    facing: 1,
    segment: sparesRoad,
    color: GOLD,
  });
  world.addBody({
    id: 'S1',
    kind: 'carriage',
    railPos: sparesLen - 188,
    facing: 1,
    segment: sparesRoad,
    color: GOLD,
  });
  world.couple('S0', 'S1');

  const poseOf = (id: string): BodyPose => {
    const p = world.bodies().find((b) => b.id === id);
    if (p === undefined) throw new Error(`no body ${id}`);
    return p;
  };

  /* Geometry the crane reaches (captured from the parked stock BEFORE any swap). */
  const trainRear = { x: poseOf('c1').x, y: poseOf('c1').y };
  const trainCouple = { x: poseOf('c0').x, y: poseOf('c0').y };
  const spares = { x: poseOf('S0').x, y: poseOf('S0').y };
  const holdMid = net.railOf(holdingRoad).at(holdLen - 154);
  const holding = { x: holdMid.x, y: holdMid.y };

  const crane = new Crane(boundsOf(net), { x: trainRear.x, y: trainRear.y });
  const ops = craneSwapOps(world);
  const ctrl = new CraneSwapController({
    crane,
    liftCut: ops.liftCut,
    placeCut: ops.placeCut,
    trainRear,
    holding,
    spares,
    trainCouple,
    loop,
  });

  return {
    world,
    crane,
    ctrl,
    /* Run to a clean boundary: `stopAfterCycles` completed swaps, observed at the
     *  instant the crane reaches `done` with an empty hook (so all bodies are back
     *  on the rails — never mid-lift, when a cut is in the air off the world). */
    run: (stopAfterCycles = 1, cap = 60 * 600) => {
      let prev = ctrl.currentPhase;
      let cycles = 0;
      for (let i = 0; i < cap; i++) {
        ctrl.tick(DT);
        crane.step(DT);
        world.step(DT);
        if (ctrl.currentPhase === 'done' && prev !== 'done') cycles++;
        prev = ctrl.currentPhase;
        if (cycles >= stopAfterCycles && ctrl.currentPhase === 'done') break;
      }
    },
  };
}

describe('CraneSwapController — the railyard crane swaps a train’s rear cut for the spares', () => {
  it('lifts the train’s two rear cars off, sets the two spares on in their place, and parks the shed cut as the next spares', () => {
    const sim = stage();

    /* Before: T is raked with its own cars; the spares are a separate cut. */
    expect(rake(sim.world, 'T')).toEqual(new Set(['T', 'c0', 'c1']));
    expect(rake(sim.world, 'S0')).toEqual(new Set(['S0', 'S1']));

    sim.run();

    /* The crane completed its cycle and is empty-hooked. */
    expect(sim.ctrl.currentPhase).toBe('done');
    expect(sim.crane.carrying).toBe(false);

    /* After: T now pulls the former SPARES, and its old cars are gone from its rake. */
    const tRake = rake(sim.world, 'T');
    expect(tRake.has('S0')).toBe(true);
    expect(tRake.has('S1')).toBe(true);
    expect(tRake.has('c0')).toBe(false);
    expect(tRake.has('c1')).toBe(false);

    /* The shed cut sits in the holding road as a coupled pair — the NEXT spares —
     *  and is no longer attached to the train. */
    const shed = rake(sim.world, 'c0');
    expect(shed).toEqual(new Set(['c0', 'c1']));

    /* Every body stayed on the rails (nothing floated, derailed, or vanished). */
    const ids = sim.world.bodies().map((b) => b.id);
    for (const id of ['T', 'c0', 'c1', 'S0', 'S1']) expect(ids).toContain(id);
    expect(sim.world.bodies().every((b) => b.mode === 'railed')).toBe(true);
  });

  it('loops: a second cycle sheds the spares again and re-rakes the train with its first cars (train→train migration)', () => {
    const sim = stage(true);
    /* Two full swap cycles — an even count returns the train to its original cars. */
    sim.run(2);

    /* After an even number of cycles the train is back to pulling c0/c1, and S0/S1
     *  are the parked spares again — the rakes migrated train→spares→train. */
    const tRake = rake(sim.world, 'T');
    expect(tRake.has('c0')).toBe(true);
    expect(tRake.has('c1')).toBe(true);
    expect(tRake.has('S0')).toBe(false);
    expect(tRake.has('S1')).toBe(false);
    expect(rake(sim.world, 'S0')).toEqual(new Set(['S0', 'S1']));
    expect(sim.world.bodies().every((b) => b.mode === 'railed')).toBe(true);
  });
});
