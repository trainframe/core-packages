import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../physics/world.js';
import { buildYardLayout } from '../physics/yard.js';
import { Crane } from './crane.js';
import { physicsMotorActuator } from './motor-actuator.js';
import { physicsSwitchActuator } from './switch-actuator.js';
import { TrainDevice } from './train-device.js';
import { YardController, craneBounds } from './yard-controller.js';

/** Stage a yard, a visiting loco+3 rake on the west lead, and a 2-car spare cut in
 *  slot B, then run the CV controller to completion (or a step cap). */
function serviceRun(): { world: PhysicsWorld; phase: string } {
  const yard = buildYardLayout();
  const w = new PhysicsWorld(yard.net);

  // Visitor: loco + 3 carriages, coupled, on the west lead facing east.
  w.addBody({ id: 'L', kind: 'loco', railPos: 400, facing: 1, segment: 'leadW', color: 'red' });
  for (let i = 0; i < 3; i++) {
    const id = `a${i}`;
    w.addBody({
      id,
      kind: 'carriage',
      railPos: 400 - (i + 1) * 68,
      facing: 1,
      segment: 'leadW',
      color: 'amber',
    });
    w.couple(i === 0 ? 'L' : `a${i - 1}`, id);
  }
  // Spares already sitting in slot B (west part), coupled together.
  w.addBody({
    id: 'p0',
    kind: 'carriage',
    railPos: 200,
    facing: 1,
    segment: 'slot1',
    color: 'purple',
  });
  w.addBody({
    id: 'p1',
    kind: 'carriage',
    railPos: 132,
    facing: 1,
    segment: 'slot1',
    color: 'purple',
  });
  w.couple('p0', 'p1');

  const train = new TrainDevice('L', physicsMotorActuator(w, 'L'));
  const b = craneBounds(yard);
  const crane = new Crane(b, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  const ctrl = new YardController({
    layout: yard,
    train,
    westPoints: physicsSwitchActuator(w, 'Jw'),
    eastPoints: physicsSwitchActuator(w, 'Je'),
    look: (x, y) => {
      const s = w.sampleAt(x, y, 20);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
    cameraRadius: 20,
    wedgeAt: (x, y) => {
      w.uncoupleAt(x, y);
    },
    crane,
    entrySlot: 'slot0',
    sparesSlot: 'slot1',
  });

  const dt = 1 / 60;
  for (let i = 0; i < 4000 && ctrl.currentPhase !== 'done'; i++) {
    ctrl.tick(dt);
    crane.step(dt);
    w.step(dt);
  }
  return { world: w, phase: ctrl.currentPhase };
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

describe('YardController — a full CV-driven service', () => {
  it('enters a slot, sheds the rear cut, picks up the spares, and leaves with them', () => {
    const { world, phase } = serviceRun();
    const segOf = (id: string) => world.bodies().find((b) => b.id === id)?.segment;

    expect(phase).toBe('done'); // ran the whole choreography

    const train = rake(world, 'L');
    // Departing train = loco + the kept front car + the picked-up spares.
    expect(train).toEqual(new Set(['L', 'a0', 'p0', 'p1']));
    // The rear cut (a1,a2) was shed, left coupled to itself, parked in slot A.
    expect(train.has('a1')).toBe(false);
    expect(train.has('a2')).toBe(false);
    expect(rake(world, 'a1')).toEqual(new Set(['a1', 'a2']));
    expect(segOf('a2')).toBe('slot0');
    // And the serviced train left toward the opposite (east) throat.
    expect(['leadE', 'eleg1', 'slot1']).toContain(segOf('L'));
  });
});
