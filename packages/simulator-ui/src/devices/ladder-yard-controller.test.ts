import { describe, expect, it } from 'vitest';
import { buildFullRailyardScene } from '../physics/railyard-pieces.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { physicsSwitchActuator } from '../sim/switch-actuator.js';
import { Crane } from './crane.js';
import { LadderYardController, type SlotGeom } from './ladder-yard-controller.js';
import { TrainDevice } from './train-device.js';

const CAMERA_R = 30;

/** Build the full real-piece scene + a world, seed a loco with two carriages on the
 *  bottom run heading toward the yard, and wire a LadderYardController to the world
 *  through the camera + actuators (the composition root's job, done inline here). */
function setup() {
  const scene = buildFullRailyardScene();
  const world = new PhysicsWorld(scene.net);
  world.setSwitch(scene.passingLoop.switchId, scene.passingLoop.mainPos);

  /* A visiting train: loco + two coupled carriages, on the bottom run. */
  /* Seed well along bot-mid so the two carriages fit behind the loco at proper
   *  spacing (not clamped on top of one another at the segment start). */
  world.addBody({
    id: 'T',
    kind: 'loco',
    railPos: 200,
    facing: 1,
    segment: 'bot-mid',
    color: 'red',
    motion: 'stopped',
    maxSpeed: 150,
  });
  for (let i = 0; i < 2; i++) {
    const id = `T-c${i}`;
    world.addBody({
      id,
      kind: 'carriage',
      segment: 'bot-mid',
      railPos: 200 - (i + 1) * 68,
      facing: 1,
      color: 'red',
    });
    world.couple(i === 0 ? 'T' : `T-c${i - 1}`, id);
  }

  const slots: SlotGeom[] = scene.yard.slots.map((id) => {
    const g = scene.geom.get(id);
    if (g === undefined) throw new Error(`no geom for ${id}`);
    /* Slots are built buffer-first: rail start = buffer, end = mouth. */
    return { mouth: g.end, buffer: g.start };
  });
  const headG = scene.geom.get(scene.yard.headshunt);
  if (headG === undefined) throw new Error('no headshunt geom');

  const xs = slots.flatMap((s) => [s.mouth.x, s.buffer.x]).concat(headG.start.x, headG.end.x);
  const ys = slots.flatMap((s) => [s.mouth.y, s.buffer.y]).concat(headG.start.y, headG.end.y);
  const bounds = {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
  const crane = new Crane(bounds, { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY });

  const controller = new LadderYardController({
    train: new TrainDevice('T', physicsMotorActuator(world, 'T')),
    throat: physicsSwitchActuator(world, scene.yard.throatSwitch),
    enterPos: scene.yard.enterPos,
    thruPos: scene.yard.thruPos,
    ladder: scene.yard.ladderSwitches.map((sw) => physicsSwitchActuator(world, sw)),
    ladderThruPos: scene.yard.ladderThruPos,
    ladderSlotPos: scene.yard.ladderSlotPos,
    slots,
    headshuntRest: headG.end,
    look: (x, y) => {
      const s = world.sampleAt(x, y, CAMERA_R);
      return s === null
        ? { occupied: false }
        : { occupied: true, colour: s.colour, at: { x: s.x, y: s.y } };
    },
    cameraRadius: CAMERA_R,
    wedgeAt: (x, y) => {
      world.uncoupleAt(x, y);
    },
    crane,
  });

  return { scene, world, crane, controller };
}

/** Run world + controller + crane for `seconds`. */
function run(s: ReturnType<typeof setup>, seconds: number): void {
  const DT = 1 / 60;
  for (let i = 0; i < 60 * seconds; i++) {
    s.world.step(DT);
    s.controller.tick(DT);
    s.crane.step(DT);
  }
}

describe('LadderYardController — reverse-in servicing of the real-piece yard', () => {
  it('reverse-ins the rake into a free slot, then uncouples and pulls the loco clear', () => {
    const s = setup();
    run(s, 60);

    expect(s.controller.currentPhase).toBe('done');
    const chosenSlot = s.scene.yard.slots[s.controller.chosenSlot];
    expect(chosenSlot).toBeDefined();

    const bodies = new Map(s.world.bodies().map((b) => [b.id, b]));
    const loco = bodies.get('T');
    const c0 = bodies.get('T-c0');
    const c1 = bodies.get('T-c1');

    /* The carriages are parked in the chosen slot... */
    expect(c0?.segment).toBe(chosenSlot);
    expect(c1?.segment).toBe(chosenSlot);
    /* ...the loco has been uncoupled from them... */
    expect(loco?.coupledTo ?? []).not.toContain('T-c0');
    /* ...and pulled clear of the slot (out onto the lead / running line). */
    expect(loco?.segment).not.toBe(chosenSlot);
    /* No body left the rails. */
    for (const b of s.world.bodies()) expect(b.fate).toBe('on-rail');
  });

  it('full journey: diverts round the passing loop, then reverse-ins past an occupied slot', () => {
    const scene = buildFullRailyardScene();
    const world = new PhysicsWorld(scene.net);
    /* Divert the visitor round the passing-loop siding on its way to the yard. */
    world.setSwitch(scene.passingLoop.switchId, scene.passingLoop.loopPos);
    /* Pre-park a cut in slot 0 so the service must choose a later slot. */
    const slot0 = scene.yard.slots[0];
    if (slot0 === undefined) throw new Error('no slot0');
    world.addBody({
      id: 'p0',
      kind: 'carriage',
      segment: slot0,
      railPos: 200,
      facing: 1,
      color: 'green',
    });
    /* Seed the visitor BEFORE the passing loop. */
    world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 300,
      facing: 1,
      segment: scene.startSegment,
      color: 'red',
      maxSpeed: 150,
    });
    for (let i = 0; i < 2; i++) {
      const id = `T-c${i}`;
      world.addBody({
        id,
        kind: 'carriage',
        railPos: 300 - (i + 1) * 68,
        facing: 1,
        segment: scene.startSegment,
        color: 'red',
      });
      world.couple(i === 0 ? 'T' : `T-c${i - 1}`, id);
    }
    const slots: SlotGeom[] = scene.yard.slots.map((id) => {
      const g = scene.geom.get(id);
      if (g === undefined) throw new Error(`no geom ${id}`);
      return { mouth: g.end, buffer: g.start };
    });
    const headG = scene.geom.get(scene.yard.headshunt);
    if (headG === undefined) throw new Error('no headshunt geom');
    const xs = slots.flatMap((s) => [s.mouth.x, s.buffer.x]);
    const ys = slots.flatMap((s) => [s.mouth.y, s.buffer.y]);
    const bounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
    const crane = new Crane(bounds, { x: bounds.minX, y: bounds.minY });
    const controller = new LadderYardController({
      train: new TrainDevice('T', physicsMotorActuator(world, 'T')),
      throat: physicsSwitchActuator(world, scene.yard.throatSwitch),
      enterPos: scene.yard.enterPos,
      thruPos: scene.yard.thruPos,
      ladder: scene.yard.ladderSwitches.map((sw) => physicsSwitchActuator(world, sw)),
      ladderThruPos: scene.yard.ladderThruPos,
      ladderSlotPos: scene.yard.ladderSlotPos,
      slots,
      headshuntRest: headG.end,
      look: (x, y) => {
        const s = world.sampleAt(x, y, CAMERA_R);
        return s === null
          ? { occupied: false }
          : { occupied: true, colour: s.colour, at: { x: s.x, y: s.y } };
      },
      cameraRadius: CAMERA_R,
      wedgeAt: (x, y) => {
        world.uncoupleAt(x, y);
      },
      crane,
    });
    const DT = 1 / 60;
    let divertedRoundLoop = false;
    for (let i = 0; i < 60 * 90; i++) {
      world.step(DT);
      controller.tick(DT);
      crane.step(DT);
      if (world.bodies().some((b) => b.id === 'T' && b.segment === scene.passingLoop.loop)) {
        divertedRoundLoop = true;
      }
    }
    expect(divertedRoundLoop).toBe(true); // it really went round the siding
    expect(controller.currentPhase).toBe('done');
    expect(controller.chosenSlot).toBeGreaterThan(0); // skipped the occupied slot 0
    const chosen = scene.yard.slots[controller.chosenSlot];
    const c1 = world.bodies().find((b) => b.id === 'T-c1');
    expect(c1?.segment).toBe(chosen);
  });

  it('picks a FREE slot — skips one already occupied by a parked cut', () => {
    const s = setup();
    /* Pre-park a cut in slot 0 so the service must choose a later slot. */
    const slot0 = s.scene.yard.slots[0];
    if (slot0 === undefined) throw new Error('no slot0');
    const g = s.scene.geom.get(slot0);
    if (g === undefined) throw new Error('no slot0 geom');
    s.world.addBody({
      id: 'parked',
      kind: 'carriage',
      segment: slot0,
      railPos: 30,
      facing: 1,
      color: 'green',
    });

    run(s, 60);
    expect(s.controller.chosenSlot).toBeGreaterThan(0); // not slot 0
    expect(s.controller.currentPhase).toBe('done');
  });
});
