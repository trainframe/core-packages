import { describe, expect, it } from 'vitest';
import { addParallelogramYard } from './parallelogram-yard.js';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';
import { PhysicsWorld } from './world.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const SLOTS = 5;

/** A parallelogram yard spliced into a simple running line: approach → top lead,
 *  bottom lead → tail. */
function buildScene() {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const afterApproach = b.run('approach', start, [STRAIGHT, STRAIGHT]);
  const yard = addParallelogramYard(b, afterApproach, { prefix: 'PG', slots: SLOTS });
  b.link('approach', yard.topLeadIn);
  b.run('tail', yard.segments.bottomLeadOut, [STRAIGHT, STRAIGHT, STRAIGHT]);
  b.link(yard.segments.bottomLeadOutSeg, 'tail');
  return { net: b.build().net, yard };
}

/** Set every turnout (both ladders) to `thru`, except slot `i`'s pair to `slot`.
 *  The outer-corner curves have no switch (`undefined`) and are skipped. */
function pointToSlot(world: PhysicsWorld, yard: ReturnType<typeof buildScene>['yard'], i: number) {
  const { topSwitches, bottomSwitches, slotPos, thruPos } = yard.segments;
  for (const [k, sw] of topSwitches.entries())
    if (sw !== undefined) world.setSwitch(sw, k === i ? slotPos : thruPos);
  for (const [k, sw] of bottomSwitches.entries())
    if (sw !== undefined) world.setSwitch(sw, k === i ? slotPos : thruPos);
}

/** Seed a forward loco at (startSeg, railPos, facing) and run it, returning the set of
 *  segments it visited until it runs off the open end or a step cap. */
function collectRun(
  world: PhysicsWorld,
  startSeg: string,
  facing: 1 | -1,
  railPos: number,
): Set<string> {
  world.addBody({
    id: 'T',
    kind: 'loco',
    railPos,
    facing,
    segment: startSeg,
    motion: 'forward',
    maxSpeed: 180,
  });
  const visited = new Set<string>();
  for (let s = 0; s < 60 * 90; s++) {
    world.step(1 / 60);
    const p = world.bodies()[0];
    if (p === undefined) break;
    visited.add(p.segment);
    if (p.fate !== 'on-rail') break;
  }
  return visited;
}

/** Drive a train through slot `i`, entering from `startSeg` heading `facing`. */
function driveThrough(i: number, startSeg: string, facing: 1 | -1, railPos: number): Set<string> {
  const { net, yard } = buildScene();
  const world = new PhysicsWorld(net);
  pointToSlot(world, yard, i);
  return collectRun(world, startSeg, facing, railPos);
}

/** Enter from the top lead (the approach, forward). */
function driveIntoSlot(i: number): Set<string> {
  return driveThrough(i, 'approach', 1, 10);
}

describe('addParallelogramYard — a drive-through parallelogram stabling fan', () => {
  it('builds overlap-clean with the requested number of parallel slots', () => {
    const { yard } = buildScene();
    expect(yard.segments.slots).toHaveLength(SLOTS);
    expect(yard.segments.topSwitches).toHaveLength(SLOTS);
    expect(yard.segments.bottomSwitches).toHaveLength(SLOTS);
  });

  it('makes the outer corners plain curves (no switch where there is no choice)', () => {
    const { yard } = buildScene();
    /* Trailing slot's top + leading slot's bottom are curves → no switch there. */
    expect(yard.segments.topSwitches[SLOTS - 1]).toBeUndefined();
    expect(yard.segments.bottomSwitches[0]).toBeUndefined();
    /* Every other corner is a real switch. */
    expect(yard.segments.topSwitches.slice(0, SLOTS - 1).every((s) => s !== undefined)).toBe(true);
    expect(yard.segments.bottomSwitches.slice(1).every((s) => s !== undefined)).toBe(true);
  });

  it('is configurable to N slots (and each builds clean + drives through)', () => {
    for (const n of [2, 3, 7]) {
      const b = new PieceNetworkBuilder();
      const a = b.run('approach', { x: 0, y: 0, dir: 0, layer: 0 }, [STRAIGHT, STRAIGHT]);
      const yard = addParallelogramYard(b, a, { prefix: 'N', slots: n });
      b.link('approach', yard.topLeadIn);
      b.run('tail', yard.segments.bottomLeadOut, [STRAIGHT, STRAIGHT]);
      b.link(yard.segments.bottomLeadOutSeg, 'tail');
      expect(() => b.build()).not.toThrow();
      expect(yard.segments.slots).toHaveLength(n);
    }
  });

  it('drives a train in the top lead, into EACH slot, and out the bottom lead', () => {
    for (let i = 0; i < SLOTS; i++) {
      const visited = driveIntoSlot(i);
      expect(visited.has(`PG-slot${i}`)).toBe(true); // it took slot i
      expect(visited.has('tail')).toBe(true); // and reached the onward line via the bottom lead
    }
  });

  it('is DIRECTIONLESS: drives in the BOTTOM lead, into a slot, and out the top lead', () => {
    /* Enter from the tail (the bottom-lead side) heading the other way (-1). It must
     *  divert up a slot and reach the approach (the top-lead side). */
    const visited = driveThrough(2, 'tail', -1, 10);
    expect(visited.has('PG-slot2')).toBe(true);
    expect(visited.has('approach')).toBe(true);
  });

  it('does not stable in the WRONG slot (the points route it to exactly one)', () => {
    const visited = driveIntoSlot(2);
    for (let k = 0; k < SLOTS; k++) {
      if (k !== 2) expect(visited.has(`PG-slot${k}`)).toBe(false);
    }
  });

  it('flipped: hangs BELOW a westbound run (flat leads, slots down) and still drives through', () => {
    const b = new PieceNetworkBuilder();
    const a = b.run('approach', { x: 0, y: 0, dir: 180, layer: 0 }, [STRAIGHT, STRAIGHT]); // west
    const yard = addParallelogramYard(b, a, { prefix: 'F', slots: SLOTS, flipped: true });
    b.link('approach', yard.topLeadIn);
    b.run('tail', yard.segments.bottomLeadOut, [STRAIGHT, STRAIGHT]);
    b.link(yard.segments.bottomLeadOutSeg, 'tail');
    const net = b.build().net;
    /* Both leads flat; the bottom lead sits BELOW the top lead (larger screen-y). */
    const topY = net.railOf('F-topin').at(0).y;
    const botY = net.railOf(yard.segments.bottomLeadOutSeg).at(0).y;
    expect(botY).toBeGreaterThan(topY + 400);

    const world = new PhysicsWorld(net);
    pointToSlot(world, yard, 2);
    const visited = collectRun(world, 'approach', 1, 10);
    expect(visited.has('F-slot2')).toBe(true);
    expect(visited.has('tail')).toBe(true);
  });
});
