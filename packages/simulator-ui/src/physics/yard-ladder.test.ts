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

/** Drive a body from the approach with the throat + ladder set to reach `target`
 *  (a slot index, or -1 to stay on the running line); return the segment it ends on. */
function driveTo(target: number): string {
  const { net, seg } = buildScene();
  const world = new PhysicsWorld(net);
  if (target < 0) {
    world.setSwitch(seg.throatSwitch, seg.thruPos);
  } else {
    world.setSwitch(seg.throatSwitch, seg.enterPos);
    seg.ladderSwitches.forEach((sw, i) => {
      world.setSwitch(sw, i === target ? seg.ladderSlotPos : seg.ladderThruPos);
    });
  }
  world.addBody({
    id: 'T',
    kind: 'loco',
    railPos: 5,
    facing: 1,
    segment: 'approach',
    color: 'red',
    motion: 'forward',
    maxSpeed: 160,
  });
  const DT = 1 / 60;
  let last = 'approach';
  for (let i = 0; i < 60 * 40; i++) {
    world.step(DT);
    const body = world.bodies()[0];
    if (body !== undefined) last = body.segment;
  }
  return last;
}

describe('yard ladder — dead-end slots from real pieces', () => {
  it('builds overlap-clean (no slot crosses another)', () => {
    expect(() => buildScene()).not.toThrow();
  });

  it('the throat keeps a non-visiting train on the running line', () => {
    expect(driveTo(-1)).toBe('depart');
  });

  it('each slot is reachable: the ladder routes a train into slot i to its buffer', () => {
    for (let i = 0; i < SLOTS; i++) {
      expect(driveTo(i)).toBe(`Y-slot${i}`);
    }
  });
});
