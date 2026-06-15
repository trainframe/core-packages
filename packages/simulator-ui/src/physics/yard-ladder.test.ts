import { describe, expect, it } from 'vitest';
import { type Cursor, PieceNetworkBuilder } from './piece-network.js';
import { PhysicsWorld } from './world.js';
import { type YardLadderSegments, addYardLadder } from './yard-ladder.js';

const SLOTS = 3;

function buildScene(): {
  net: ReturnType<PieceNetworkBuilder['build']>['net'];
  seg: YardLadderSegments;
} {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const approach = b.run('approach', start, [{ type: 'straight' }]);
  const { spineExit, segments, inbound } = addYardLadder(b, approach, {
    prefix: 'Y',
    slots: SLOTS,
  });
  b.link('approach', inbound);
  b.run('depart', spineExit, [{ type: 'straight' }]);
  b.link(segments.spineThrough, 'depart');
  return { net: b.build().net, seg: segments };
}

/** Reverse-IN a train to slot `target`: enter the lead, pull all the way onto the
 *  headshunt (every turnout `thru`), then set the target turnout to `slot` and
 *  back in. Returns the segment the train comes to rest on. */
function reverseInto(target: number): string {
  const { net, seg } = buildScene();
  const world = new PhysicsWorld(net);
  world.setSwitch(seg.throatSwitch, seg.enterPos);
  for (const sw of seg.ladderSwitches) world.setSwitch(sw, seg.ladderThruPos);
  world.addBody({
    id: 'T',
    kind: 'loco',
    railPos: 5,
    facing: 1,
    segment: 'approach',
    color: 'red',
    motion: 'forward',
    maxSpeed: 140,
  });
  const DT = 1 / 60;
  /* Pull forward onto the headshunt. */
  for (let i = 0; i < 60 * 25; i++) world.step(DT);
  /* Set back into the target slot. */
  world.setSwitch(seg.ladderSwitches[target] ?? '', seg.ladderSlotPos);
  world.setMotion('T', 'reverse');
  let last = 'approach';
  for (let i = 0; i < 60 * 30; i++) {
    world.step(DT);
    const body = world.bodies()[0];
    if (body !== undefined) last = body.segment;
  }
  return last;
}

describe('yard ladder — reverse-in dead-end slots from real pieces', () => {
  it('builds overlap-clean (no slot crosses another)', () => {
    expect(() => buildScene()).not.toThrow();
  });

  it('the throat keeps a non-visiting train on the running line', () => {
    const { net, seg } = buildScene();
    const world = new PhysicsWorld(net);
    world.setSwitch(seg.throatSwitch, seg.thruPos);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 5,
      facing: 1,
      segment: 'approach',
      color: 'red',
      motion: 'forward',
      maxSpeed: 140,
    });
    const DT = 1 / 60;
    let last = 'approach';
    for (let i = 0; i < 60 * 30; i++) {
      world.step(DT);
      const body = world.bodies()[0];
      if (body !== undefined) last = body.segment;
    }
    expect(last).toBe('depart');
  });

  it('a train pulling down the lead runs onto the headshunt, clear of every slot', () => {
    const { net, seg } = buildScene();
    const world = new PhysicsWorld(net);
    world.setSwitch(seg.throatSwitch, seg.enterPos);
    for (const sw of seg.ladderSwitches) world.setSwitch(sw, seg.ladderThruPos);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 5,
      facing: 1,
      segment: 'approach',
      color: 'red',
      motion: 'forward',
      maxSpeed: 140,
    });
    const DT = 1 / 60;
    let last = 'approach';
    for (let i = 0; i < 60 * 30; i++) {
      world.step(DT);
      const body = world.bodies()[0];
      if (body !== undefined) last = body.segment;
    }
    expect(last).toBe(seg.headshunt);
  });

  it('each slot is reverse-in reachable: backing in lands the train in slot i', () => {
    for (let i = 0; i < SLOTS; i++) {
      expect(reverseInto(i)).toBe(`Y-slot${i}`);
    }
  });
});
