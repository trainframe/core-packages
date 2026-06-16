/**
 * Composition-root coverage for the 4-train interesting-railway demo. Real seams only —
 * an `InProcessBus` + `inProcessPlatform` device↔core link and a real `PhysicsWorld`
 * from the scene, no mocking. We prove the assembly composes (scene, layout, 4 trains,
 * 3 switch devices, routes), every device registers, the 4 locos seed clear of one
 * another, and a train actually drives its world body forward when granted clearance.
 *
 * The full scheduler-driven behaviour (4 trains keeping schedules, station dwells, yard
 * queue, no deadlock) is the headless integration gate's job — here we only prove the
 * wiring composes and the `step` loop moves the world.
 */
import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { InProcessBus, inProcessPlatform } from '../devices/platform-provider.js';
import { buildInterestingRailwayDemo } from './interesting-railway-demo.js';

const DT = 1 / 60;

function setup() {
  const bus = new InProcessBus();
  const demo = buildInterestingRailwayDemo((id) => inProcessPlatform(bus, id));
  return { bus, demo };
}

describe('buildInterestingRailwayDemo — 4-train composition root', () => {
  it('exposes the scene, compiled layout, world, 4 trains, and 3 running-line switches', () => {
    const { demo } = setup();
    expect(demo.layout.markers.length).toBeGreaterThan(0);
    expect(demo.trainIds).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(demo.switchDeviceIds).toEqual(['SWITCH-M-satA-jn', 'SWITCH-M-satB-jn', 'SWITCH-M-yard']);
    for (const id of demo.trainIds) expect(demo.routes.get(id)?.stops.length).toBeGreaterThan(0);
  });

  it('seeds the 4 locos on the network, each clear of the others', () => {
    const { demo } = setup();
    const locos = demo.world.bodies().filter((b) => b.kind === 'loco');
    expect(locos.map((b) => b.id).sort()).toEqual(['T1', 'T2', 'T3', 'T4']);
    /* No two locos seeded on top of each other. */
    for (let i = 0; i < locos.length; i++) {
      for (let j = i + 1; j < locos.length; j++) {
        const a = locos[i];
        const b = locos[j];
        if (a && b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(60);
      }
    }
  });

  it('registers every device (train + switch) on start', () => {
    const { bus, demo } = setup();
    const registered = new Set<string>();
    for (const id of [...demo.trainIds, ...demo.switchDeviceIds]) {
      bus.onEvent(id, (e) => {
        if (e.event_type === 'device_registered') registered.add(id);
      });
    }
    demo.start();
    for (const id of [...demo.trainIds, ...demo.switchDeviceIds])
      expect(registered.has(id)).toBe(true);
    expect(bus.manifestOf('T1')?.capabilities).toContain('core.controls_motion');
    demo.stop();
  });

  it('drives a train forward in the world when granted clearance', () => {
    const { bus, demo } = setup();
    demo.start();
    const before = demo.world.bodies().find((b) => b.id === 'T1');
    /* T1 is seeded at its home M-north; its first edge runs to the satellite-A junction. */
    bus.sendCommand('T1', {
      command_id: '00000000-0000-4000-8000-0000000000b1',
      device_id: 'T1',
      timestamp_server: '1970-01-01T00:00:00.000Z',
      command_type: 'assign_route',
      protocol_version: PROTOCOL_VERSION,
      payload: {
        route_id: 'r1',
        edges: [{ from_marker_id: 'M-north', to_marker_id: 'M-satA-jn' }],
      },
    });
    bus.sendCommand('T1', {
      command_id: '00000000-0000-4000-8000-0000000000b2',
      device_id: 'T1',
      timestamp_server: '1970-01-01T00:00:00.000Z',
      command_type: 'grant_clearance',
      protocol_version: PROTOCOL_VERSION,
      payload: { limit_marker_id: 'M-satA-jn' },
    });
    for (let i = 0; i < 120; i++) demo.step(DT);
    const after = demo.world.bodies().find((b) => b.id === 'T1');
    const moved = Math.hypot(
      (after?.x ?? 0) - (before?.x ?? 0),
      (after?.y ?? 0) - (before?.y ?? 0),
    );
    expect(moved).toBeGreaterThan(5);
    demo.stop();
  });
});
