import { describe, expect, it } from 'vitest';
import type { Rail } from '../physics/rail.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { TrainDevice } from './train-device.js';

const straight = (length: number): Rail => ({
  length,
  at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
  curvatureAt: () => 0,
  pieceTypeAt: () => 'straight',
  slopeAt: () => 0,
  startBuffered: false,
  endBuffered: false,
});

const run = (w: PhysicsWorld, steps: number) => {
  for (let i = 0; i < steps; i++) w.step(0.05);
};
const xOf = (w: PhysicsWorld, id: string) => w.bodies().find((b) => b.id === id)?.x ?? Number.NaN;

describe('TrainDevice over a sim-backed MotorActuator', () => {
  it('drives the body through the actuator → world, with no direct world poke', () => {
    const w = new PhysicsWorld(straight(4000));
    w.addBody({ id: 'loco', kind: 'loco', railPos: 200, facing: 1 });
    const device = new TrainDevice('loco', physicsMotorActuator(w, 'loco'));

    // Forward: the body advances.
    device.forward();
    expect(device.motion).toBe('forward');
    run(w, 60);
    const afterForward = xOf(w, 'loco');
    expect(afterForward).toBeGreaterThan(300);

    // Stop: it brakes to rest.
    device.stop();
    run(w, 60);
    const afterStop = xOf(w, 'loco');
    expect(Math.abs(afterStop - xOf(w, 'loco'))).toBe(0);

    // Reverse: it backs up (x decreases from the stopped point).
    device.reverse();
    run(w, 40);
    expect(xOf(w, 'loco')).toBeLessThan(afterStop);
  });
});
