import { describe, expect, it } from 'vitest';
import { buildMainLoopScene } from './railyard-pieces.js';
import { PhysicsWorld } from './world.js';

describe('railyard-pieces — main loop from real pieces', () => {
  it('closes and a train laps it without leaving the rails', () => {
    const scene = buildMainLoopScene();
    const g = scene.geom.get(scene.mainLoop);
    if (g === undefined) throw new Error('no main-loop geom');
    expect(Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y)).toBeLessThan(6); // closes

    const world = new PhysicsWorld(scene.net);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: scene.mainLoop,
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
    for (let i = 0; i < 60 * 90; i++) {
      world.step(DT);
      const b = world.bodies()[0];
      if (b === undefined) continue;
      if (b.fate !== 'on-rail' || b.mode !== 'railed') leftRails = true;
      const d = Math.hypot(b.x - startPt.x, b.y - startPt.y);
      maxDist = Math.max(maxDist, d);
      if (maxDist > 400 && d < 50) lapped = true;
    }
    expect(leftRails).toBe(false);
    expect(maxDist).toBeGreaterThan(400);
    expect(lapped).toBe(true);
  });
});
