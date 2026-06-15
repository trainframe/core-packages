import { describe, expect, it } from 'vitest';
import { buildRailyardScene } from '../physics/railyard-scene.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { physicsSwitchActuator } from '../sim/switch-actuator.js';
import {
  RailyardDemoController,
  type RailyardDemoTrain,
  type YardJob,
} from './railyard-demo-controller.js';
import { TrainDevice } from './train-device.js';

describe('railyard demo long-run (full view seeding)', () => {
  it('runs 5 trains + 3 jobs collision-free, railed, with 3 services', () => {
    const layout = buildRailyardScene(3);
    const world = new PhysicsWorld(layout.net);
    const seed = (loco: string, seg: string, railPos: number, cars: number): void => {
      world.addBody({
        id: loco,
        kind: 'loco',
        railPos,
        facing: 1,
        segment: seg,
        color: '#999',
        power: 820,
        maxSpeed: 300,
      });
      for (let i = 0; i < cars; i++) {
        const id = `${loco}c${i}`;
        world.addBody({
          id,
          kind: 'carriage',
          railPos: railPos - (i + 1) * 68,
          facing: 1,
          segment: seg,
          color: '#999',
        });
        world.couple(i === 0 ? loco : `${loco}c${i - 1}`, id);
      }
    };
    seed('LA', 'top', 1780, 3);
    seed('LB', 'bottom', 700, 3);
    seed('LC', 'rightA', 150, 3);
    seed('LD', 'iBottom', 320, 2);
    seed('LE', 'iTop', 320, 2);
    world.addBody({
      id: 'g0',
      kind: 'carriage',
      railPos: 200,
      facing: 1,
      segment: 'slot1',
      color: '#e0a81e',
    });
    world.addBody({
      id: 'g1',
      kind: 'carriage',
      railPos: 132,
      facing: 1,
      segment: 'slot1',
      color: '#e0a81e',
    });
    world.couple('g0', 'g1');

    const train = (id: string): RailyardDemoTrain => ({
      train: new TrainDevice(id, physicsMotorActuator(world, id)),
      locoId: id,
    });
    const jobs: YardJob[] = [
      { locoId: 'LA', entrySlot: 'slot0', sparesSlot: 'slot1' },
      { locoId: 'LB', entrySlot: 'slot1', sparesSlot: 'slot0' },
      { locoId: 'LC', entrySlot: 'slot0', sparesSlot: 'slot1' },
    ];
    const ctrl = new RailyardDemoController({
      layout,
      loops: [
        {
          order: layout.loops[0]?.blocks.map((b) => b.id) ?? [],
          trains: [train('LA'), train('LB'), train('LC')],
        },
        {
          order: layout.loops[1]?.blocks.map((b) => b.id) ?? [],
          trains: [train('LD'), train('LE')],
        },
      ],
      loopPoints: physicsSwitchActuator(world, layout.loopSwitch),
      westPoints: physicsSwitchActuator(world, layout.yard.westSwitch),
      eastPoints: physicsSwitchActuator(world, layout.yard.eastSwitch),
      bodies: () => world.bodies(),
      look: (x, y) => {
        const s = world.sampleAt(x, y, 20);
        return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
      },
      cameraRadius: 20,
      wedgeAt: (x, y) => {
        world.uncoupleAt(x, y);
      },
      yardJobs: jobs,
    });

    const { leftRails, firstOff } = runUntilServices(world, ctrl, 3);
    expect(leftRails, `body left rails: ${firstOff}`).toBe(false);
    expect(ctrl.servicesCompleted).toBeGreaterThanOrEqual(3);
  });
});

/** Step the world+controller until `target` services complete (or a generous
 *  cap), watching for any body that leaves the rails (derail / run-off / floats). */
function runUntilServices(
  world: PhysicsWorld,
  ctrl: RailyardDemoController,
  target: number,
): { leftRails: boolean; firstOff: string } {
  const DT = 1 / 120;
  let leftRails = false;
  let firstOff = '';
  for (let i = 0; i < 120 * 360 && ctrl.servicesCompleted < target; i++) {
    ctrl.tick(DT);
    world.step(DT);
    const off = world.bodies().find((b) => b.fate !== 'on-rail' || b.mode !== 'railed');
    if (off !== undefined && !leftRails) {
      leftRails = true;
      firstOff = `${off.id} fate=${off.fate} mode=${off.mode} seg=${off.segment}`;
    }
  }
  return { leftRails, firstOff };
}
