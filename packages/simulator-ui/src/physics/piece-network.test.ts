import { describe, expect, it } from 'vitest';
import { type Cursor, PieceNetworkBuilder } from './piece-network.js';
import { PhysicsWorld } from './world.js';

/** A rounded-square loop built from REAL pieces: four sides of two straights, four
 *  corners of two 45° curves (8 curves = 360°, so it closes). */
function ovalBuilder(): PieceNetworkBuilder {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const side = [{ type: 'straight' as const }, { type: 'straight' as const }];
  const corner = [{ type: 'curve' as const }, { type: 'curve' as const }];
  b.run('loop', start, [...side, ...corner, ...side, ...corner, ...side, ...corner, ...side, ...corner]);
  /* Close the loop: the run's END links back to its own START. */
  b.link('loop', 'loop');
  return b;
}

describe('PieceNetworkBuilder — a layout from real track pieces', () => {
  it('lays a closed loop of real pieces and closes geometrically', () => {
    const { net, pieces, geom } = ovalBuilder().build();
    /* Real pieces, not bezier: straights + curves only. */
    expect(pieces.length).toBe(16);
    expect(pieces.every((p) => p.type === 'straight' || p.type === 'curve')).toBe(true);
    const rail = net.railOf('loop');
    expect(rail.length).toBeGreaterThan(0);
    /* The loop closes: the run's start and end world points coincide. */
    const g = geom.get('loop');
    if (g === undefined) throw new Error('no loop geom');
    expect(Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y)).toBeLessThan(5);
  });

  it('a train drives the whole loop on the real-piece rails without leaving them', () => {
    const { net } = ovalBuilder().build();
    const world = new PhysicsWorld(net);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: 'loop',
      color: 'red',
      motion: 'forward',
      maxSpeed: 240,
    });
    const start = world.bodies()[0];
    if (start === undefined) throw new Error('no body');
    const startPt = { x: start.x, y: start.y };
    let maxDist = 0;
    let returnedAfterFar = false;
    let everLeftRails = false;
    const DT = 1 / 60;
    for (let i = 0; i < 60 * 60; i++) {
      world.step(DT);
      const b = world.bodies()[0];
      if (b === undefined) continue;
      if (b.fate !== 'on-rail' || b.mode !== 'railed') everLeftRails = true;
      const dist = Math.hypot(b.x - startPt.x, b.y - startPt.y);
      maxDist = Math.max(maxDist, dist);
      /* A completed lap: it got far from the start, then came back near it. */
      if (maxDist > 300 && dist < 40) returnedAfterFar = true;
    }
    expect(everLeftRails).toBe(false); // stayed on the real-piece rails throughout
    expect(maxDist).toBeGreaterThan(300); // genuinely circulated, not stuck
    expect(returnedAfterFar).toBe(true); // completed at least one full lap
  });

  /** Build: main run → junction → through run + branch run, all real pieces. */
  function branchBuilder(): PieceNetworkBuilder {
    const b = new PieceNetworkBuilder();
    const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
    const after = b.run('main', start, [{ type: 'straight' }, { type: 'straight' }]);
    const { thruExit, branchExit } = b.junction('jt', 'jb', after, {
      switchId: 'J',
      thruPos: 'thru',
      branchPos: 'branch',
    });
    b.run('thruRun', thruExit, [{ type: 'straight' }, { type: 'straight' }]);
    b.run('branchRun', branchExit, [{ type: 'straight' }, { type: 'straight' }]);
    b.link('main', 'jt', { switchId: 'J', position: 'thru' });
    b.link('main', 'jb', { switchId: 'J', position: 'branch' });
    b.link('jt', 'thruRun');
    b.link('jb', 'branchRun');
    return b;
  }

  /** Drive a train from 'main' with the junction set to `pos`; return the segment
   *  it ends on. */
  function driveThroughJunction(pos: string): string {
    const { net } = branchBuilder().build();
    const world = new PhysicsWorld(net);
    world.setSwitch('J', pos);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: 'main',
      color: 'red',
      motion: 'forward',
      maxSpeed: 200,
    });
    const DT = 1 / 60;
    let seg = 'main';
    for (let i = 0; i < 60 * 30; i++) {
      world.step(DT);
      const b = world.bodies()[0];
      if (b !== undefined && (b.segment === 'thruRun' || b.segment === 'branchRun')) {
        seg = b.segment;
        break;
      }
    }
    return seg;
  }

  it('a junction routes the train down the through OR branch run per the switch', () => {
    expect(driveThroughJunction('thru')).toBe('thruRun');
    expect(driveThroughJunction('branch')).toBe('branchRun');
  });
});
