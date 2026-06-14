import { describe, expect, it } from 'vitest';
import { buildRailyardScene, cornerSeg } from './railyard-scene.js';
import { PhysicsWorld } from './world.js';

describe('cornerSeg', () => {
  it('turns from the entry tangent to the exit tangent with real curvature', () => {
    /* A quarter turn from east (0°) to north (-90°). */
    const c = cornerSeg(0, 0, 100, -100, 0, -90);
    expect(c.length).toBeGreaterThan(100); // an arc is longer than the chord… smaller than 2×
    const start = c.at(0);
    const end = c.at(c.length);
    expect(start.x).toBeCloseTo(0, 1);
    expect(start.y).toBeCloseTo(0, 1);
    expect(end.x).toBeCloseTo(100, 1);
    expect(end.y).toBeCloseTo(-100, 1);
    /* Heading swings from ~0° toward ~-90° over the corner. */
    expect(Math.abs(c.at(0).headingDeg)).toBeLessThan(20);
    expect(c.at(c.length).headingDeg).toBeLessThan(-70);
    /* Real (non-zero) curvature mid-corner — an over-fast train would derail. */
    expect(Math.abs(c.curvatureAt(c.length / 2))).toBeGreaterThan(0);
    expect(c.pieceTypeAt(0)).toBe('curve');
    expect(c.slopeAt(0)).toBe(0);
  });
});

describe('buildRailyardScene', () => {
  it('is a closed loop of straights + real curved corners with a yard split', () => {
    const layout = buildRailyardScene(3);
    /* The loop has curved corners — not a plain rectangle. */
    const curved = layout.loop.filter((b) => b.curved);
    expect(curved.length).toBeGreaterThanOrEqual(4);
    /* The diverge + rejoin blocks and the loop switch exist. */
    expect(layout.loop.map((b) => b.id)).toContain(layout.divergeBlock);
    expect(layout.loop.map((b) => b.id)).toContain(layout.rejoinBlock);
    expect(layout.connectors.length).toBe(2);
    /* The embedded yard's segments + switches are present in the combined net. */
    expect(layout.net.segments()).toContain(layout.yard.leadWest);
    expect(layout.net.segments()).toContain(layout.entrySlot);
    expect(layout.net.segments()).toContain('connIn');
  });

  it('routes a train all the way around the loop, taking the curves on-rail', () => {
    const layout = buildRailyardScene(3);
    const w = new PhysicsWorld(layout.net);
    w.setSwitch(layout.loopSwitch, layout.loopThruPos);
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      segment: 'bottom',
      motion: 'forward',
      power: 1100,
    });
    const visited = new Set<string>();
    for (let i = 0; i < 60 * 60; i++) {
      w.step(1 / 60);
      const b = w.bodies()[0];
      if (b !== undefined) visited.add(b.segment);
    }
    const b = w.bodies()[0];
    /* It is still on the rails (held the curves) and has visited every loop block
     *  — a full lap of the closed cycle. */
    expect(b?.fate).toBe('on-rail');
    for (const block of layout.loop) expect(visited.has(block.id)).toBe(true);
    /* It NEVER strayed onto the yard branch (loop points set to through). */
    expect(visited.has('connIn')).toBe(false);
    expect(visited.has(layout.entrySlot)).toBe(false);
  });

  it('diverts a train into the yard branch when the loop points are thrown', () => {
    const layout = buildRailyardScene(3);
    const w = new PhysicsWorld(layout.net);
    w.setSwitch(layout.loopSwitch, layout.loopYardPos);
    w.setSwitch(layout.yard.westSwitch, 'thru');
    w.setSwitch(layout.yard.eastSwitch, 'thru');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      segment: layout.divergeBlock,
      motion: 'forward',
      power: 700,
      maxSpeed: 220,
    });
    const visited = new Set<string>();
    for (let i = 0; i < 60 * 40; i++) {
      w.step(1 / 60);
      const b = w.bodies()[0];
      if (b !== undefined) visited.add(b.segment);
    }
    /* It left the loop via the connector into the yard west lead and stayed railed. */
    expect(visited.has('connIn')).toBe(true);
    expect(visited.has(layout.yard.leadWest)).toBe(true);
    expect(w.bodies()[0]?.fate).toBe('on-rail');
  });
});
