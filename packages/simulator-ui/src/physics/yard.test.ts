import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './world.js';
import { buildYardLayout } from './yard.js';

const run = (w: PhysicsWorld, steps: number) => {
  for (let i = 0; i < steps; i++) w.step(0.05);
};
const pose = (w: PhysicsWorld, id: string) => {
  const p = w.bodies().find((b) => b.id === id);
  if (!p) throw new Error(`no body ${id}`);
  return p;
};

describe('yard interior network', () => {
  it('a train self-drives the spine into the entry slot when tap A is set to slot', () => {
    const yard = buildYardLayout();
    const w = new PhysicsWorld(yard.net);
    w.setSwitch('tapA', 'slot');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      motion: 'forward',
      segment: yard.throatSegment,
    });
    run(w, 200);
    const t = pose(w, 'T');
    expect(t.segment).toBe('slotA'); // diverted off the spine into the slot
    expect(t.fate).toBe('on-rail');
    expect(t.speed).toBeLessThan(2); // stopped at the slot's buffer, no marker/core
  });

  it('with tap A through and tap B to slot, the train runs past A and into slot B', () => {
    const yard = buildYardLayout();
    const w = new PhysicsWorld(yard.net);
    w.setSwitch('tapA', 'through');
    w.setSwitch('tapB', 'slot');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      motion: 'forward',
      segment: yard.throatSegment,
    });
    run(w, 240);
    expect(pose(w, 'T').segment).toBe('slotB');
  });

  it('with both taps through, the train runs the spine clear to the far end', () => {
    const yard = buildYardLayout();
    const w = new PhysicsWorld(yard.net);
    w.setSwitch('tapA', 'through');
    w.setSwitch('tapB', 'through');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      motion: 'forward',
      segment: yard.throatSegment,
    });
    run(w, 240);
    expect(pose(w, 'T').segment).toBe('spine2');
  });
});
