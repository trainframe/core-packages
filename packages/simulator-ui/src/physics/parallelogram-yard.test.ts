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

/** Set every turnout (both ladders) to `thru`, except slot `i`'s pair to `slot`. */
function pointToSlot(world: PhysicsWorld, yard: ReturnType<typeof buildScene>['yard'], i: number) {
  const { topSwitches, bottomSwitches, slotPos, thruPos } = yard.segments;
  topSwitches.forEach((sw, k) => world.setSwitch(sw, k === i ? slotPos : thruPos));
  bottomSwitches.forEach((sw, k) => world.setSwitch(sw, k === i ? slotPos : thruPos));
}

/** Drive a train through slot `i`, entering from `startSeg` heading `facing`,
 *  returning the segments it visited (until it runs off the open end or a cap). */
function driveThrough(i: number, startSeg: string, facing: 1 | -1, railPos: number): Set<string> {
  const { net, yard } = buildScene();
  const world = new PhysicsWorld(net);
  pointToSlot(world, yard, i);
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
});
