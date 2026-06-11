/**
 * The CameraProvider seam, with the optional occlusion hook (ADR-030 sensing).
 * A camera sees a body beneath its footprint — UNLESS an occlusion predicate
 * (a dark tunnel) reports the footprint covered, in which case it honestly
 * returns empty even though the body is physically there.
 */
import { describe, expect, it } from 'vitest';
import type { Rail } from '../physics/rail.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsCameraProvider } from './camera-provider.js';

/** A straight rail along +x: railPos maps directly to world x. */
function straightRail(length: number): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

describe('physicsCameraProvider', () => {
  it('reports occupied + colour for a body beneath the footprint', () => {
    const world = new PhysicsWorld(straightRail(1000));
    world.addBody({ id: 'T', kind: 'loco', railPos: 500, facing: 1, color: '#abc' });
    const cam = physicsCameraProvider(world, { x: 500, y: 0, radiusMm: 20 });
    expect(cam.perceive()).toEqual({ occupied: true, colour: '#abc' });
  });

  it('reports empty when the body is elsewhere', () => {
    const world = new PhysicsWorld(straightRail(1000));
    world.addBody({ id: 'T', kind: 'loco', railPos: 100, facing: 1 });
    const cam = physicsCameraProvider(world, { x: 500, y: 0, radiusMm: 20 });
    expect(cam.perceive().occupied).toBe(false);
  });

  it('returns EMPTY when the footprint is occluded, though the body is there', () => {
    const world = new PhysicsWorld(straightRail(1000));
    world.addBody({ id: 'T', kind: 'loco', railPos: 500, facing: 1, color: '#abc' });
    /* A predicate that occludes exactly this footprint — a dark roof over it. */
    const cam = physicsCameraProvider(world, { x: 500, y: 0, radiusMm: 20 }, () => true);
    expect(cam.perceive()).toEqual({ occupied: false });
  });

  it('still sees when the occlusion predicate reports clear', () => {
    const world = new PhysicsWorld(straightRail(1000));
    world.addBody({ id: 'T', kind: 'loco', railPos: 500, facing: 1, color: '#abc' });
    const cam = physicsCameraProvider(world, { x: 500, y: 0, radiusMm: 20 }, () => false);
    expect(cam.perceive().occupied).toBe(true);
  });
});
