import { describe, expect, it } from 'vitest';
import { type Cursor, PieceNetworkBuilder } from './piece-network.js';
import { addTrapezoidYard } from './trapezoid-yard.js';
import { PhysicsWorld } from './world.js';

const N = 3;
function build() {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const approach = b.run('approach', start, [{ type: 'straight' }]);
  const { segments, inbound } = addTrapezoidYard(b, approach, { prefix: 'Y', sidings: N });
  b.link('approach', inbound);
  return { net: b.build().net, seg: segments };
}

describe('trapezoid yard — drive-in stabling fan', () => {
  it('builds overlap-clean (sidings fan, none cross)', () => {
    expect(() => build()).not.toThrow();
  });
  it('a train drives into each selected siding to its buffer', () => {
    for (let i = 0; i < N; i++) {
      const { net, seg } = build();
      const w = new PhysicsWorld(net);
      seg.ladderSwitches.forEach((sw, k) => w.setSwitch(sw, k === i ? seg.slotPos : seg.thruPos));
      w.addBody({
        id: 'T',
        kind: 'loco',
        railPos: 5,
        facing: 1,
        segment: 'approach',
        color: 'red',
        motion: 'forward',
        maxSpeed: 140,
      });
      let last = 'approach';
      for (let s = 0; s < 60 * 30; s++) {
        w.step(1 / 60);
        const bd = w.bodies()[0];
        if (bd) last = bd.segment;
      }
      expect(last).toBe(`Y-siding${i}`);
    }
  });
});
