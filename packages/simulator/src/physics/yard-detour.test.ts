import { describe, expect, it } from 'vitest';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';
import { PhysicsWorld } from './world.js';
import { addYardDetour } from './yard-detour.js';

const STRAIGHT: PieceSpec = { type: 'straight' };

/** A westbound running line with a yard detour spliced in, and an onward run. */
function buildScene(slots = 4) {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 180, layer: 0 };
  const afterMain = b.run('main', start, [STRAIGHT, STRAIGHT]);
  const detour = addYardDetour(b, 'main', afterMain, { prefix: 'YD', slots });
  b.run('onward', detour.onward, [STRAIGHT, STRAIGHT]);
  b.link('YD-mthru', 'onward');
  b.link('YD-mbr', 'onward');
  return { net: b.build().net, detour };
}

/** Point the yard's two ladders to route a train through slot `i`. */
function pointToSlot(
  w: PhysicsWorld,
  sl: ReturnType<typeof buildScene>['detour']['segments']['yard'],
  i: number,
) {
  for (const [k, sw] of sl.topSwitches.entries())
    if (sw !== undefined) w.setSwitch(sw, k === i ? sl.slotPos : sl.thruPos);
  for (const [k, sw] of sl.bottomSwitches.entries())
    if (sw !== undefined) w.setSwitch(sw, k === i ? sl.slotPos : sl.thruPos);
}

/** Run a forward loco from `main` and return the segments it visits. */
function drive(net: ReturnType<typeof buildScene>['net'], setup: (w: PhysicsWorld) => void) {
  const w = new PhysicsWorld(net);
  setup(w);
  w.addBody({
    id: 'T',
    kind: 'loco',
    railPos: 10,
    facing: 1,
    segment: 'main',
    motion: 'forward',
    maxSpeed: 180,
  });
  const visited = new Set<string>();
  for (let i = 0; i < 60 * 200; i++) {
    w.step(1 / 60);
    const p = w.bodies()[0];
    if (p === undefined) break;
    visited.add(p.segment);
    if (p.fate !== 'on-rail') break;
  }
  return visited;
}

describe('addYardDetour — drive-through yard off a running line', () => {
  it('builds overlap-clean (no same-layer crossings)', () => {
    expect(() => buildScene()).not.toThrow();
  });

  it('DIVERTS through the yard and rejoins the line by the OTHER side (no reversing)', () => {
    const { net, detour } = buildScene(4);
    const sl = detour.segments.yard;
    const visited = drive(net, (w) => {
      w.setSwitch(detour.segments.switchId, detour.segments.divertPos);
      pointToSlot(w, sl, 1);
    });
    expect(visited.has('YD-leadin')).toBe(true); // pulled onto the entry lead-in
    expect(visited.has('YD-slot1')).toBe(true); // a stabling road through the yard
    expect(visited.has('YD-climb')).toBe(true); // climbed the exit lead-in
    expect(visited.has('onward')).toBe(true); // rejoined the line and carried on
  });

  it('STAYS on the loop (the bypass) when the divert is not set', () => {
    const { net, detour } = buildScene(4);
    const visited = drive(net, (w) => {
      w.setSwitch(detour.segments.switchId, detour.segments.mainPos);
    });
    expect(visited.has('YD-bypass')).toBe(true); // took the through line
    expect(visited.has('onward')).toBe(true);
    /* Never entered the yard. */
    expect([...visited].some((s) => s.startsWith('YD-slot'))).toBe(false);
    expect(visited.has('YD-leadin')).toBe(false);
  });
});
