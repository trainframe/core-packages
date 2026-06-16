/**
 * Unit coverage for the branching demo composition root. Real seams only — an
 * `InProcessBus` + `inProcessPlatform` as the device↔core link and a real
 * `PhysicsWorld` from the scene — no mocking of devices, the bus, or the world.
 * We drive the assembly the way the gate/render script does (`step` per tick,
 * commands in via the bus, events out) and observe outcomes: every device
 * registers, the trains seed on their home markers, and a granted train actually
 * drives its world body forward.
 *
 * The full scheduler-driven behaviour (clearance, queueing, migration, no flip)
 * is the headless gate's job (`@trainframe/integration`); here we only prove the
 * wiring composes and the `step` loop moves the world.
 */
import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { InProcessBus, inProcessPlatform } from '../devices/platform-provider.js';
import { buildBranchingDemo } from './branching-demo.js';

const DT = 1 / 60;

function setup(): { bus: InProcessBus; demo: ReturnType<typeof buildBranchingDemo> } {
  const bus = new InProcessBus();
  const demo = buildBranchingDemo((id) => inProcessPlatform(bus, id));
  return { bus, demo };
}

describe('buildBranchingDemo — composition root', () => {
  it('exposes the scene, compiled layout, world, devices, and per-train routes', () => {
    const { demo } = setup();
    expect(demo.scene.throatMarker).toBe('M-yard-throat');
    expect(demo.layout.markers.length).toBeGreaterThan(0);
    expect(demo.trainIds).toEqual(['T1', 'T2', 'T4']);
    expect(demo.yardDeviceId).toBe('YARD-1');
    expect(demo.switchDeviceIds).toEqual(['SWITCH-spur']);
    for (const id of demo.trainIds) {
      expect(demo.routes.get(id)?.canReverse).toBe(true);
    }
  });

  it('seeds the loco bodies on the network plus the spares cut', () => {
    const { demo } = setup();
    const ids = demo.world.bodies().map((b) => b.id);
    for (const id of demo.trainIds) expect(ids).toContain(id);
    expect(ids).toContain('spare0');
    expect(ids).toContain('spare1');
  });

  it('registers every device (manifest + device_registered) on start', () => {
    const { bus, demo } = setup();
    const registered = new Set<string>();
    for (const id of [...demo.trainIds, demo.yardDeviceId, ...demo.switchDeviceIds]) {
      bus.onEvent(id, (e) => {
        if (e.event_type === 'device_registered') registered.add(id);
      });
    }
    demo.start();
    for (const id of demo.trainIds) expect(registered.has(id)).toBe(true);
    expect(registered.has(demo.yardDeviceId)).toBe(true);
    expect(registered.has('SWITCH-spur')).toBe(true);
    expect(bus.manifestOf('T1')?.capabilities).toContain('core.controls_motion');
    demo.stop();
  });

  it('drives a train forward in the world when the scheduler grants clearance', () => {
    const { bus, demo } = setup();
    demo.start();

    /* Assign T1 a route then grant it clearance the way the real scheduler would.
     *  T1 is seeded at its home M-main-e, so its first edge starts there; the body
     *  must physically advance under the device's motor command. */
    const t1Before = demo.world.bodies().find((b) => b.id === 'T1');
    const route = {
      command_id: '00000000-0000-4000-8000-0000000000a1',
      device_id: 'T1',
      timestamp_server: '1970-01-01T00:00:00.000Z',
      command_type: 'assign_route',
      protocol_version: PROTOCOL_VERSION,
      payload: {
        route_id: 'rA-express',
        edges: [{ from_marker_id: 'M-main-e', to_marker_id: 'M-spur' }],
      },
    } as const;
    bus.sendCommand('T1', route);
    bus.sendCommand('T1', {
      command_id: '00000000-0000-4000-8000-0000000000a2',
      device_id: 'T1',
      timestamp_server: '1970-01-01T00:00:00.000Z',
      command_type: 'grant_clearance',
      protocol_version: PROTOCOL_VERSION,
      payload: { limit_marker_id: 'M-spur' },
    });

    for (let i = 0; i < 120; i++) demo.step(DT);

    const t1After = demo.world.bodies().find((b) => b.id === 'T1');
    const moved =
      Math.hypot((t1After?.x ?? 0) - (t1Before?.x ?? 0), (t1After?.y ?? 0) - (t1Before?.y ?? 0)) >
      5;
    expect(moved).toBe(true);
    demo.stop();
  });
});
