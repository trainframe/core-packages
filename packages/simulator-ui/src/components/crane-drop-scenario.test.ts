import { JibCrane } from '@trainframe/simulator/devices/jib-crane.js';
import { TrainDevice } from '@trainframe/simulator/devices/train-device.js';
import { PhysicsWorld } from '@trainframe/simulator/physics/world.js';
import { straightSeg } from '@trainframe/simulator/physics/yard.js';
import { physicsMotorActuator } from '@trainframe/simulator/sim/motor-actuator.js';
/**
 * Headless integration of the crane-drop accident driven by the DOCK JIB CRANE
 * (the same wiring `CraneDropScenarioView` runs, minus React): the jib slews a
 * carried crate out over the running line, releases it onto the rail, the train
 * sets off and derails on it. Mirrors the video harness's `crane-drop` CHECK
 * (train derailed + crate derailed) at the physics level, so the re-skin is
 * proven without standing up a browser.
 */
import { describe, expect, it } from 'vitest';

const STEP_S = 1 / 120;
const RAIL_Y = 600;
const DROP_X = 1200;
const TOWER = { x: DROP_X, y: 940 };

describe('crane-drop scenario — the dock jib sets a crate down and the train wrecks', () => {
  it('slews a crate over the rail, drops it, and the train derails on it', () => {
    const w = new PhysicsWorld(straightSeg(150, RAIL_Y, 2050, RAIL_Y));
    w.addBody({ id: 'T', kind: 'loco', railPos: 120, facing: 1, color: '#c0392b' });
    const train = new TrainDevice('T', physicsMotorActuator(w, 'T'));
    const crane = new JibCrane({
      base: TOWER,
      limits: { minAngle: -Math.PI, maxAngle: 0, minReach: 120, maxReach: 420 },
      start: { angle: -Math.PI * 0.78, reach: 300 },
    });
    crane.grab();
    let dropped = false;

    /* The jib must finish its swing before the crate is on the rail. */
    for (let i = 0; i < 120 * 12; i++) {
      crane.aimAt(DROP_X, RAIL_Y);
      crane.step(STEP_S);
      if (!dropped && crane.carrying && crane.arrived) {
        expect(crane.release()).toBe(true);
        /* Delivered hook lands on the running line. */
        expect(crane.pos.x).toBeCloseTo(DROP_X, 0);
        expect(crane.pos.y).toBeCloseTo(RAIL_Y, 0);
        w.placeBodyAt(
          {
            id: 'crate',
            kind: 'carriage',
            facing: 1,
            color: '#7c5a33',
            mass: 0.8,
            halfLen: 18,
            obstacle: true,
          },
          crane.pos.x,
          crane.pos.y,
        );
        train.forward();
        dropped = true;
      }
      w.step(STEP_S);
    }

    expect(dropped).toBe(true);
    const bodies = w.bodies();
    const t = bodies.find((b) => b.id === 'T');
    const crate = bodies.find((b) => b.id === 'crate');
    expect(t?.fate).toBe('derailed');
    expect(crate?.fate).toBe('derailed');
  });
});
