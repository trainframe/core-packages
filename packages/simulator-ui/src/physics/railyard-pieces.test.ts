import { describe, expect, it } from 'vitest';
import {
  buildFullRailyardScene,
  buildMainLoopScene,
  buildRailyardCircuitScene,
} from './railyard-pieces.js';
import { PhysicsWorld } from './world.js';

interface LapResult {
  readonly maxDist: number;
  readonly lapped: boolean;
  readonly leftRails: boolean;
}

/** Drive the first body for `seconds` and report how far it got, whether it
 *  returned near its start (a lap) and whether it ever left the rails. */
function driveLap(world: PhysicsWorld, seconds: number): LapResult {
  const start = world.bodies()[0];
  if (start === undefined) throw new Error('no body');
  const startPt = { x: start.x, y: start.y };
  let maxDist = 0;
  let lapped = false;
  let leftRails = false;
  const DT = 1 / 60;
  for (let i = 0; i < 60 * seconds; i++) {
    world.step(DT);
    const b = world.bodies()[0];
    if (b === undefined) continue;
    if (b.fate !== 'on-rail' || b.mode !== 'railed') leftRails = true;
    const d = Math.hypot(b.x - startPt.x, b.y - startPt.y);
    maxDist = Math.max(maxDist, d);
    if (maxDist > 400 && d < 50) lapped = true;
  }
  return { maxDist, lapped, leftRails };
}

describe('railyard-pieces — main loop from real pieces', () => {
  it('closes and a train laps it without leaving the rails', () => {
    const scene = buildMainLoopScene();
    const g = scene.geom.get(scene.mainLoop);
    if (g === undefined) throw new Error('no main-loop geom');
    expect(Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y)).toBeLessThan(6); // closes

    const world = new PhysicsWorld(scene.net);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: scene.mainLoop,
      color: 'red',
      motion: 'forward',
      maxSpeed: 240,
    });
    const { maxDist, lapped, leftRails } = driveLap(world, 90);
    expect(leftRails).toBe(false);
    expect(maxDist).toBeGreaterThan(400);
    expect(lapped).toBe(true);
  });
});

/** Drive a train round the circuit with the passing-loop switch at `pos`; report
 *  the segments it visited, whether it left the rails, and whether it lapped. */
function lapCircuit(pos: string): { visited: Set<string>; leftRails: boolean; lapped: boolean } {
  const scene = buildRailyardCircuitScene();
  const world = new PhysicsWorld(scene.net);
  world.setSwitch(scene.passingLoop.switchId, pos);
  world.addBody({
    id: 'T',
    kind: 'loco',
    railPos: 10,
    facing: 1,
    segment: scene.startSegment,
    color: 'red',
    motion: 'forward',
    maxSpeed: 240,
  });
  const startPt = { ...(world.bodies()[0] ?? { x: 0, y: 0 }) };
  const visited = new Set<string>();
  let leftRails = false;
  let lapped = false;
  let maxDist = 0;
  const DT = 1 / 60;
  for (let i = 0; i < 60 * 120; i++) {
    world.step(DT);
    const b = world.bodies()[0];
    if (b === undefined) continue;
    if (b.fate !== 'on-rail' || b.mode !== 'railed') leftRails = true;
    visited.add(b.segment);
    const d = Math.hypot(b.x - startPt.x, b.y - startPt.y);
    maxDist = Math.max(maxDist, d);
    if (maxDist > 600 && d < 60) lapped = true;
  }
  return { visited, leftRails, lapped };
}

describe('railyard-pieces — full circuit with a passing loop', () => {
  it('closes the oval (both semicircle ends meet the straights) within 2 mm', () => {
    expect(buildRailyardCircuitScene().closureGapMm).toBeLessThan(2);
  });

  it('with the switch on MAIN a train laps the circuit on the straight bottom', () => {
    const r = lapCircuit('main');
    expect(r.leftRails).toBe(false);
    expect(r.lapped).toBe(true);
    expect(r.visited.has('PL-mid')).toBe(true); // stayed on the straight main
    expect(r.visited.has('PL-loop')).toBe(false); // never diverted onto the siding
  });

  it('with the switch on LOOP a train diverts round the siding and still laps', () => {
    const r = lapCircuit('loop');
    expect(r.leftRails).toBe(false);
    expect(r.lapped).toBe(true);
    expect(r.visited.has('PL-loop')).toBe(true); // diverted onto the siding
    expect(r.visited.has('PL-mid')).toBe(false); // skipped the straight main
  });
});

describe('railyard-pieces — full layout: circuit + passing loop + in-line yard', () => {
  it('builds overlap-clean (oval body, branch siding and yard never cross) and closes', () => {
    const scene = buildFullRailyardScene();
    expect(scene.closureGapMm).toBeLessThan(2);
  });

  it('a train laps the running line when the yard throat and branch are set thru/main', () => {
    const scene = buildFullRailyardScene();
    const world = new PhysicsWorld(scene.net);
    world.setSwitch(scene.passingLoop.switchId, scene.passingLoop.mainPos);
    world.setSwitch(scene.yard.throatSwitch, scene.yard.thruPos);
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: scene.startSegment,
      color: 'red',
      motion: 'forward',
      maxSpeed: 240,
    });
    const startPt = { ...(world.bodies()[0] ?? { x: 0, y: 0 }) };
    let maxDist = 0;
    let lapped = false;
    let leftRails = false;
    const DT = 1 / 60;
    for (let i = 0; i < 60 * 160; i++) {
      world.step(DT);
      const body = world.bodies()[0];
      if (body === undefined) continue;
      if (body.fate !== 'on-rail' || body.mode !== 'railed') leftRails = true;
      const d = Math.hypot(body.x - startPt.x, body.y - startPt.y);
      maxDist = Math.max(maxDist, d);
      if (maxDist > 700 && d < 70) lapped = true;
    }
    expect(leftRails).toBe(false);
    expect(lapped).toBe(true);
  });

  it('the yard admits a train off the running line into a dead-end slot', () => {
    const scene = buildFullRailyardScene();
    const world = new PhysicsWorld(scene.net);
    world.setSwitch(scene.passingLoop.switchId, scene.passingLoop.mainPos);
    world.setSwitch(scene.yard.throatSwitch, scene.yard.enterPos);
    scene.yard.ladderSwitches.forEach((sw, i) => {
      world.setSwitch(sw, i === 0 ? scene.yard.ladderSlotPos : scene.yard.ladderThruPos);
    });
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: scene.startSegment,
      color: 'red',
      motion: 'forward',
      maxSpeed: 160,
    });
    const DT = 1 / 60;
    let last = scene.startSegment;
    for (let i = 0; i < 60 * 60; i++) {
      world.step(DT);
      const body = world.bodies()[0];
      if (body !== undefined) last = body.segment;
    }
    expect(last).toBe(scene.yard.slots[0]); // pulled into the first slot, stopped at its buffer
  });
});
