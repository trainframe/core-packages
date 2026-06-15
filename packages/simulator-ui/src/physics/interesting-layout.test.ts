import { describe, expect, it } from 'vitest';
import { buildMainLoopScene } from './interesting-layout.js';
import { PhysicsWorld } from './world.js';

describe('interesting-layout — main loop with branch taps', () => {
  it('builds overlap-clean and closes', () => {
    const scene = buildMainLoopScene();
    expect(scene.closureGapMm).toBeLessThan(2);
  });

  it('exposes three branch taps (yard + two satellites)', () => {
    const { branches } = buildMainLoopScene();
    expect(branches.yard.switchId).toBe('yard-SW');
    expect(branches.satA.switchId).toBe('satA-SW');
    expect(branches.satB.switchId).toBe('satB-SW');
  });

  it('a train laps the main loop on the through route without leaving the rails', () => {
    const scene = buildMainLoopScene();
    const world = new PhysicsWorld(scene.net);
    /* Every tap on `main` so the train stays on the running loop. */
    world.setSwitch(scene.branches.yard.switchId, scene.branches.yard.mainPos);
    world.setSwitch(scene.branches.satA.switchId, scene.branches.satA.mainPos);
    world.setSwitch(scene.branches.satB.switchId, scene.branches.satB.mainPos);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: scene.startSegment,
      color: 'red',
      motion: 'forward',
      maxSpeed: 240,
    });
    const start = world.bodies()[0];
    if (start === undefined) throw new Error('no body');
    const startPt = { x: start.x, y: start.y };
    let maxDist = 0;
    let lapped = false;
    let leftRails = false;
    const DT = 1 / 60;
    for (let i = 0; i < 60 * 120; i++) {
      world.step(DT);
      const b = world.bodies()[0];
      if (b === undefined) continue;
      if (b.fate !== 'on-rail' || b.mode !== 'railed') leftRails = true;
      const d = Math.hypot(b.x - startPt.x, b.y - startPt.y);
      maxDist = Math.max(maxDist, d);
      if (maxDist > 600 && d < 60) lapped = true;
    }
    expect(leftRails).toBe(false);
    expect(lapped).toBe(true);
  });
});
