import { expect, it } from 'vitest';
import { buildMainLoopScene } from './interesting-layout.js';
import { PhysicsWorld } from './world.js';
it('train laps diverting through BOTH satellite loops without leaving the rails', () => {
  const s = buildMainLoopScene();
  const w = new PhysicsWorld(s.net);
  w.setSwitch(s.branches.yard.switchId, s.branches.yard.mainPos);
  w.setSwitch(s.branches.satA.switchId, s.branches.satA.loopPos);
  w.setSwitch(s.branches.satB.switchId, s.branches.satB.loopPos);
  w.addBody({
    id: 'T',
    kind: 'loco',
    railPos: 10,
    facing: 1,
    segment: s.startSegment,
    color: 'red',
    motion: 'forward',
    maxSpeed: 200,
  });
  const start = w.bodies()[0];
  if (start === undefined) throw new Error('no body');
  const sp = { x: start.x, y: start.y };
  let leftRails = false;
  let lapped = false;
  let maxD = 0;
  const visited = new Set<string>();
  for (let i = 0; i < 60 * 200; i++) {
    w.step(1 / 60);
    const b = w.bodies()[0];
    if (!b) continue;
    if (b.fate !== 'on-rail' || b.mode !== 'railed') leftRails = true;
    visited.add(b.segment);
    const d = Math.hypot(b.x - sp.x, b.y - sp.y);
    maxD = Math.max(maxD, d);
    if (maxD > 800 && d < 80) lapped = true;
  }
  expect(leftRails).toBe(false);
  expect(lapped).toBe(true);
  expect(visited.has('satA-loop')).toBe(true);
  expect(visited.has('satB-loop')).toBe(true);
});
