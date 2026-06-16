import { describe, expect, it } from 'vitest';
import { buildMainLoopScene } from '../physics/interesting-layout.js';
import { parallelogramYardLayout } from '../physics/parallelogram-yard-layout.js';
import { PhysicsWorld } from '../physics/world.js';
import { ladderSwitchActuator } from './ladder-switch-actuator.js';

/** Drive the body forward for up to `maxS` sim-seconds, stopping early once it is on one
 *  of `targetSegs`; returns the segment it ended on. */
function driveUntil(
  world: PhysicsWorld,
  id: string,
  targetSegs: readonly string[],
  maxS: number,
): string | undefined {
  world.setMotion(id, 'forward');
  for (let i = 0; i < maxS * 60; i++) {
    world.step(1 / 60);
    const b = world.bodies().find((x) => x.id === id);
    if (b === undefined) return undefined;
    if (targetSegs.includes(b.segment)) return b.segment;
  }
  return world.bodies().find((x) => x.id === id)?.segment;
}

function seedVisitor(world: PhysicsWorld, topLeadIn: string): void {
  world.addBody({
    id: 'V',
    kind: 'loco',
    segment: topLeadIn,
    railPos: 5,
    facing: 1,
    maxSpeed: 240,
  });
}

describe('ladder-switch-actuator — the YardController seam over a parallelogram yard', () => {
  it('routes a visitor INTO a chosen slot (west ladder) then OUT the far lead (east ladder)', () => {
    const scene = buildMainLoopScene();
    const seg = scene.yard; // the parallelogram ParallelogramYardSegments
    const layout = parallelogramYardLayout(scene.net, scene.geom, seg);
    expect(layout.slots).toEqual(seg.slots);
    const world = new PhysicsWorld(scene.net);
    const west = ladderSwitchActuator(world, seg, 'top');
    const east = ladderSwitchActuator(world, seg, 'bottom');

    /* Pick an INNER slot (the controller never rests in an outer corner). */
    const entrySlot = seg.slots[2];
    if (entrySlot === undefined) throw new Error('expected a slot 2');

    /* ROUTE-IN: west ladder → entry slot; the train diverts off the top lead into it. */
    west.set(entrySlot);
    east.set('thru');
    seedVisitor(world, seg.topLeadIn);
    expect(driveUntil(world, 'V', [entrySlot], 12), 'visitor diverted into the chosen slot').toBe(
      entrySlot,
    );

    /* PULL-THROUGH: east ladder → the entry slot connects to the exit lead; the train
     *  carries on out the FAR throat (a true drive-through — never reverses out). */
    east.set(entrySlot);
    expect(
      driveUntil(world, 'V', [seg.bottomLeadOutSeg], 20),
      'visitor drives out the opposite lead once east routes its slot',
    ).toBe(seg.bottomLeadOutSeg);
  });

  it('selects DIFFERENT slots independently (slot 1 vs slot 3 land on distinct roads)', () => {
    const scene = buildMainLoopScene();
    const seg = scene.yard;
    for (const k of [1, 3]) {
      const world = new PhysicsWorld(scene.net);
      const west = ladderSwitchActuator(world, seg, 'top');
      const slot = seg.slots[k];
      if (slot === undefined) throw new Error(`expected slot ${k}`);
      /* Route BOTH leads to slot k so reaching the foot drives through (no run-off);
       *  driveUntil returns the instant it enters the slot, proving the west routing. */
      west.set(slot);
      ladderSwitchActuator(world, seg, 'bottom').set(slot);
      seedVisitor(world, seg.topLeadIn);
      expect(driveUntil(world, 'V', [slot], 14), `routes to slot ${k}`).toBe(slot);
    }
  });
});
