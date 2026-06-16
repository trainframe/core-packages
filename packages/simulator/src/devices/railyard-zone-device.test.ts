import type { CoreEvent } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { buildFullRailyardScene } from '../physics/railyard-pieces.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { physicsSwitchActuator } from '../sim/switch-actuator.js';
import type { SlotGeom } from './ladder-yard-controller.js';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';
import { RailyardZoneDevice } from './railyard-zone-device.js';

const CAM_R = 30;

/** Build the scene + world + a RailyardZoneDevice wired to the world, plus a captured
 *  event log. The throat camera is STUBBED to report the visitor present (the
 *  scheduler would have routed it to the throat); everything else is real. */
function setup() {
  const scene = buildFullRailyardScene();
  const world = new PhysicsWorld(scene.net);
  world.setSwitch(scene.passingLoop.switchId, scene.passingLoop.mainPos);

  /* A cut already parked in slot 0 — the service must choose a later slot. */
  const slot0 = scene.yard.slots[0];
  if (slot0 !== undefined) {
    world.addBody({
      id: 'p0',
      kind: 'carriage',
      segment: slot0,
      railPos: 200,
      facing: 1,
      color: 'green',
    });
  }

  /* The visitor on the bottom run, heading toward the yard. */
  world.addBody({
    id: 'V',
    kind: 'loco',
    railPos: 200,
    facing: 1,
    segment: 'bot-mid',
    color: 'red',
    maxSpeed: 150,
  });
  for (let i = 0; i < 2; i++) {
    const id = `V-c${i}`;
    world.addBody({
      id,
      kind: 'carriage',
      railPos: 200 - (i + 1) * 68,
      facing: 1,
      segment: 'bot-mid',
      color: 'red',
    });
    world.couple(i === 0 ? 'V' : `V-c${i - 1}`, id);
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
  const craneBounds = {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };

  /* The owned-marker declaration (the "frame footprint"): the throat boundary plus
   *  the interior switches under the frame (ADR-034). */
  const ownedMarkerIds = [
    scene.throatMarker,
    scene.yard.throatSwitch,
    ...scene.yard.ladderSwitches,
  ];

  const events: CoreEvent[] = [];
  let released = false;
  const bus = new InProcessBus();
  bus.onEvent('YARD-1', (e) => {
    events.push(e);
    if (e.event_type === 'zone_train_released') released = true;
  });

  const device = new RailyardZoneDevice('YARD-1', {
    platform: inProcessPlatform(bus, 'YARD-1'),
    throatMarker: scene.throatMarker,
    ownedMarkerIds,
    capacity: 2,
    throat: physicsSwitchActuator(world, scene.yard.throatSwitch),
    ladder: scene.yard.ladderSwitches.map((sw) => physicsSwitchActuator(world, sw)),
    enterPos: scene.yard.enterPos,
    thruPos: scene.yard.thruPos,
    ladderThruPos: scene.yard.ladderThruPos,
    ladderSlotPos: scene.yard.ladderSlotPos,
    slots,
    headshuntRest: headG.end,
    craneBounds,
    throatPoint: { x: 0, y: 0 },
    look: (x, y) => {
      const s = world.sampleAt(x, y, CAM_R);
      return s === null
        ? { occupied: false }
        : { occupied: true, colour: s.colour, at: { x: s.x, y: s.y } };
    },
    wedgeAt: (x, y) => {
      world.uncoupleAt(x, y);
    },
    /* STUB throat camera: reports the routed visitor present until it is released —
     *  a departed train is no longer sighted (so it isn't re-admitted). */
    sightedTrainAt: () => (released ? null : 'V'),
    motorFor: (id) => physicsMotorActuator(world, id),
  });

  return { scene, world, device, events, ownedMarkerIds };
}

const typesOf = (events: readonly CoreEvent[]) => events.map((e) => e.event_type);

describe('RailyardZoneDevice — gates_zone + owned-marker declaration + reverse-in service', () => {
  it('declares the markers under the frame on registration (ADR-034)', () => {
    const s = setup();
    s.device.start();
    const reg = s.events.find((e) => e.event_type === 'device_registered');
    expect(reg).toBeDefined();
    const payload = reg?.payload as { capabilities: string[]; owned_marker_ids?: string[] };
    expect(payload.capabilities).toContain('core.gates_zone');
    expect(payload.owned_marker_ids).toEqual(s.ownedMarkerIds);
    /* And it announces its initial (empty) occupancy. */
    expect(typesOf(s.events)).toContain('zone_state_changed');
  });

  it('admits, reverse-in services, and releases a visiting train', () => {
    const s = setup();
    s.device.start();
    const DT = 1 / 60;
    for (let i = 0; i < 60 * 60; i++) {
      s.world.step(DT);
      s.device.step(DT);
    }
    /* The visitor was released back to core authority. */
    const released = s.events.find((e) => e.event_type === 'zone_train_released');
    expect(released).toBeDefined();
    expect((released?.payload as { train_id: string }).train_id).toBe('V');
    /* Its cut is parked in a free slot (not slot 0, which was occupied). */
    const c1 = s.world.bodies().find((b) => b.id === 'V-c1');
    expect(c1?.segment).not.toBe(s.scene.yard.slots[0]);
    expect(c1?.segment?.startsWith('Y-slot')).toBe(true);
    /* Occupancy returned to zero after release. */
    expect(s.device.occupancy).toBe(0);
  });
});
