import { describe, expect, it } from 'vitest';
import { parallelogramYardLayout } from '../physics/parallelogram-yard-layout.js';
import { addParallelogramYard } from '../physics/parallelogram-yard.js';
import { type Cursor, PieceNetworkBuilder } from '../physics/piece-network.js';
import { PhysicsWorld } from '../physics/world.js';
import { ladderSwitchActuator } from '../sim/ladder-switch-actuator.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { Crane } from './crane.js';
import { TrainDevice } from './train-device.js';
import { YardController, craneBounds } from './yard-controller.js';

/**
 * The SAME `YardController` swap, this time over the PARALLELOGRAM yard's DIAGONAL
 * slots — proving the controller is slot-orientation-agnostic (one mechanism, two
 * shapes). A long approach lead stages the visiting rake clear of the ladder.
 */
function serviceRun(): { world: PhysicsWorld; phase: string; layoutSlots: readonly string[] } {
  const b = new PieceNetworkBuilder();
  const entry: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  /* A 4-straight approach so the loco + 3-car rake stands clear of the first turnout. */
  const approachEnd = b.run('approach', entry, [
    { type: 'straight' },
    { type: 'straight' },
    { type: 'straight' },
    { type: 'straight' },
  ]);
  const yard = addParallelogramYard(b, approachEnd, { prefix: 'y', slots: 5 });
  b.link('approach', yard.topLeadIn);
  const built = b.build();
  const seg = yard.segments;
  const layout = parallelogramYardLayout(built.net, built.geom, seg);

  const w = new PhysicsWorld(built.net);
  // Visitor: loco + 3 carriages, coupled, on the approach lead facing into the yard.
  w.addBody({ id: 'L', kind: 'loco', railPos: 700, facing: 1, segment: 'approach', color: 'red' });
  for (let i = 0; i < 3; i++) {
    const id = `a${i}`;
    w.addBody({
      id,
      kind: 'carriage',
      railPos: 700 - (i + 1) * 68,
      facing: 1,
      segment: 'approach',
      color: 'amber',
    });
    w.couple(i === 0 ? 'L' : `a${i - 1}`, id);
  }
  // Spares already stabled in an inner slot, coupled together.
  const entrySlot = seg.slots[2];
  const sparesSlot = seg.slots[1];
  if (entrySlot === undefined || sparesSlot === undefined) throw new Error('need inner slots');
  const sparesLen = built.net.railOf(sparesSlot).length;
  w.addBody({
    id: 'p0',
    kind: 'carriage',
    railPos: sparesLen * 0.55,
    facing: 1,
    segment: sparesSlot,
    color: 'purple',
  });
  w.addBody({
    id: 'p1',
    kind: 'carriage',
    railPos: sparesLen * 0.55 - 68,
    facing: 1,
    segment: sparesSlot,
    color: 'purple',
  });
  w.couple('p0', 'p1');

  const train = new TrainDevice('L', physicsMotorActuator(w, 'L'));
  const bounds = craneBounds(layout);
  const crane = new Crane(bounds, {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  });
  const ctrl = new YardController({
    layout,
    train,
    westPoints: ladderSwitchActuator(w, seg, 'top'),
    eastPoints: ladderSwitchActuator(w, seg, 'bottom'),
    look: (x, y) => {
      const s = w.sampleAt(x, y, 20);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
    cameraRadius: 20,
    wedgeAt: (x, y) => {
      w.uncoupleAt(x, y);
    },
    crane,
    entrySlot,
    sparesSlot,
  });

  const dt = 1 / 60;
  for (let i = 0; i < 12000 && ctrl.currentPhase !== 'done'; i++) {
    ctrl.tick(dt);
    crane.step(dt);
    w.step(dt);
  }
  return { world: w, phase: ctrl.currentPhase, layoutSlots: seg.slots };
}

/** The set of ids coupled to `id` (its rake), by flood-fill over couplings. */
function rake(world: PhysicsWorld, id: string): Set<string> {
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

describe('YardController over a PARALLELOGRAM yard (diagonal slots — one swap, two shapes)', () => {
  it('enters a diagonal slot, sheds the rear cut, picks up the spares, and leaves with them', () => {
    const { world, phase } = serviceRun();
    expect(phase).toBe('done');

    const train = rake(world, 'L');
    /* Departing train = loco + the kept front car + the picked-up spares. */
    expect(train.has('p0')).toBe(true);
    expect(train.has('p1')).toBe(true);
    expect(train.has('a0')).toBe(true);
    /* The rear cut (a1,a2) was shed — no longer part of the visiting train. */
    expect(train.has('a1')).toBe(false);
    expect(train.has('a2')).toBe(false);
    expect(rake(world, 'a1')).toEqual(new Set(['a1', 'a2']));
  });
});
