import { describe, expect, it } from 'vitest';
import { TurntableActuator } from '../devices/turntable-actuator.js';
import type { TrackPiece } from '../track/pieces.js';
import { compileNetwork } from './network-from-pieces.js';
import { PhysicsWorld } from './world.js';

const DT = 1 / 60;
const SWITCH = 'M-tt';

const piece = (
  id: string,
  type: TrackPiece['type'],
  x: number,
  y: number,
  rotationDeg: TrackPiece['rotationDeg'],
): TrackPiece => ({ id, type, position: { x, y }, rotationDeg, tagged: false });

/** A turntable at the origin with a lead in from the west and a road off each rim:
 *  east (stub-a, 0°), south-east (stub-b, 45°) and north-east (stub-c, -45°). */
function yard(): readonly TrackPiece[] {
  const d = 100 * Math.SQRT1_2;
  return [
    piece('lead', 'straight', -200, 0, 0),
    piece('tt', 'turntable', 0, 0, 0),
    piece('road-a', 'straight', 200, 0, 0),
    piece('road-b', 'straight', d * 2, d * 2, 45),
    piece('road-c', 'straight', d * 2, -d * 2, 315),
  ];
}

/** A loco seated on `seg`, 40 mm in from the end farther from the turntable, facing
 *  the turntable, so it drives straight at it regardless of how the compiler oriented
 *  the rail. */
function placeLocoFacingTurntable(
  world: PhysicsWorld,
  compiled: ReturnType<typeof compileNetwork>,
  seg: string,
): void {
  const g = compiled.geom.get(seg);
  const rail = compiled.net.railOf(seg);
  if (g === undefined) throw new Error(`no geometry for ${seg}`);
  const startFar = Math.hypot(g.start.x, g.start.y) > Math.hypot(g.end.x, g.end.y);
  world.addBody({
    id: 'L',
    kind: 'loco',
    segment: seg,
    railPos: startFar ? 40 : rail.length - 40,
    facing: startFar ? 1 : -1,
  });
}

function segmentOf(compiled: ReturnType<typeof compileNetwork>, id: string): string {
  const seg = compiled.segmentsForPiece.get(id)?.[0];
  if (seg === undefined) throw new Error(`no segment for ${id}`);
  return seg;
}

function locoSegment(world: PhysicsWorld): string {
  const body = world.bodies().find((b) => b.id === 'L');
  if (body === undefined) throw new Error('no loco');
  return body.segment;
}

describe('compileNetwork — a placed turntable', () => {
  it('compiles the deck as one rail through the pit centre and records its exits', () => {
    const compiled = compileNetwork(yard());
    const deck = segmentOf(compiled, 'tt');
    expect(compiled.net.railOf(deck).length).toBeCloseTo(200, 6);
    expect(compiled.contradictions).toEqual([]);
    expect(compiled.turntableExits.get('tt')?.map((e) => e.position)).toEqual([
      'stub-a',
      'stub-b',
      'stub-c',
    ]);
    expect(compiled.turntableExits.get('tt')?.map((e) => Math.round(e.angleDeg))).toEqual([
      0, 45, -45,
    ]);
  });

  it('the deck far end sits on the rim of whichever road the bridge points at', () => {
    const compiled = compileNetwork(yard());
    const deck = segmentOf(compiled, 'tt');
    const angle = compiled.deckAngles.get('tt');
    if (angle === undefined) throw new Error('no deck angle');
    const g = compiled.geom.get(deck);
    const rail = compiled.net.railOf(deck);
    /* The compiler may have oriented the deck either way round; the rotating end is
     * whichever one is not on the lead. */
    const free = (d: number) => rail.at(d);
    const rotatingEnd = Math.abs(free(0).x + 100) < 1 ? free(200) : free(0);
    expect(g).toBeDefined();
    angle.deg = 45;
    const after = Math.abs(free(0).x + 100) < 1 ? free(200) : free(0);
    expect(rotatingEnd.x).toBeCloseTo(100, 3);
    expect(after.x).toBeCloseTo(100 * Math.SQRT1_2, 3);
    expect(after.y).toBeCloseTo(100 * Math.SQRT1_2, 3);
  });

  it('a train drives off the lead, across the deck and out the road it is aligned to', () => {
    const compiled = compileNetwork(yard());
    const world = new PhysicsWorld(compiled.net);
    world.setSwitch(SWITCH, 'stub-a');
    placeLocoFacingTurntable(world, compiled, segmentOf(compiled, 'lead'));
    world.setMotion('L', 'forward');
    const visited = new Set<string>();
    for (let i = 0; i < 60 * 12 && locoSegment(world) !== segmentOf(compiled, 'road-a'); i++) {
      world.step(DT);
      visited.add(locoSegment(world));
    }
    expect(visited).toEqual(
      new Set([
        segmentOf(compiled, 'lead'),
        segmentOf(compiled, 'tt'),
        segmentOf(compiled, 'road-a'),
      ]),
    );
    expect(world.bodies().find((b) => b.id === 'L')?.fate).toBe('on-rail');
  });

  it('does not link the lead to the deck while no road is seated', () => {
    const compiled = compileNetwork(yard());
    const world = new PhysicsWorld(compiled.net);
    placeLocoFacingTurntable(world, compiled, segmentOf(compiled, 'lead'));
    world.setMotion('L', 'forward');
    for (let i = 0; i < 60 * 10; i++) world.step(DT);
    expect(locoSegment(world)).toBe(segmentOf(compiled, 'lead'));
    expect(world.bodies().find((b) => b.id === 'L')?.mode).toBe('free');
  });

  it('carries a train onto the deck, rotates the bridge and drives it off another road', () => {
    const compiled = compileNetwork(yard());
    const deckSeg = segmentOf(compiled, 'tt');
    const angle = compiled.deckAngles.get('tt');
    const exits = compiled.turntableExits.get('tt');
    if (angle === undefined || exits === undefined) throw new Error('no turntable');
    const world = new PhysicsWorld(compiled.net);
    const actuator = new TurntableActuator({
      exits,
      switchId: SWITCH,
      points: { set: (position) => world.setSwitch(SWITCH, position) },
      limits: { minDeg: -180, maxDeg: 180 },
      startDeg: 0,
    });
    const tick = () => {
      actuator.step(DT);
      angle.deg = actuator.pos;
      world.step(DT);
    };

    placeLocoFacingTurntable(world, compiled, segmentOf(compiled, 'lead'));
    world.setMotion('L', 'forward');
    const pastCentre = () => {
      const body = world.bodies().find((b) => b.id === 'L');
      return locoSegment(world) === deckSeg && (body?.x ?? 0) > 10;
    };
    for (let i = 0; i < 60 * 12 && !pastCentre(); i++) tick();
    expect(pastCentre()).toBe(true);

    /* Hold the loco on the deck while the bridge swings to the south-east road. */
    world.setMotion('L', 'stopped');
    actuator.alignTo('stub-b');
    for (let i = 0; i < 60 * 8; i++) tick();
    expect(actuator.alignedExit).toBe('stub-b');
    expect(locoSegment(world)).toBe(deckSeg);
    const parked = world.bodies().find((b) => b.id === 'L');
    expect(parked?.rotationDeg).toBeCloseTo(45, 0);

    world.setMotion('L', 'forward');
    for (let i = 0; i < 60 * 8 && locoSegment(world) === deckSeg; i++) tick();
    expect(locoSegment(world)).toBe(segmentOf(compiled, 'road-b'));
    expect(world.bodies().find((b) => b.id === 'L')?.fate).toBe('on-rail');
  });
});
