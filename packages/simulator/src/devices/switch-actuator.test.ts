import { describe, expect, it } from 'vitest';
import { buildNetwork } from '../physics/network.js';
import type { Rail } from '../physics/rail.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsSwitchActuator } from '../sim/switch-actuator.js';

const seg = (length: number): Rail => ({
  length,
  at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
  curvatureAt: () => 0,
  pieceTypeAt: () => 'straight',
  slopeAt: () => 0,
  startBuffered: false,
  endBuffered: false,
});

function junctionWorld(): PhysicsWorld {
  const net = buildNetwork(
    new Map<string, Rail>([
      ['trunk', seg(400)],
      ['a', seg(400)],
      ['b', seg(400)],
    ]),
    [
      { from: 'trunk', to: 'a', when: { switchId: 'J', position: 'a' } },
      { from: 'trunk', to: 'b', when: { switchId: 'J', position: 'b' } },
    ],
  );
  return new PhysicsWorld(net);
}

describe('SwitchActuator over the physics world', () => {
  it('throwing the switch through the actuator routes the train onto that branch', () => {
    const w = junctionWorld();
    const points = physicsSwitchActuator(w, 'J');
    points.set('b'); // device throws the points to branch b
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      motion: 'forward',
      segment: 'trunk',
    });
    for (let i = 0; i < 60; i++) w.step(0.05);
    expect(w.bodies().find((x) => x.id === 'T')?.segment).toBe('b');
  });
});
