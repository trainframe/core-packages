/**
 * Unit tests for the scheduler-driven loco + its marker sensor, driven through
 * the REAL in-process bus (`inProcessPlatform`, not a mock) against a REAL
 * `PhysicsWorld`. We publish core commands onto the bus, step the world + the
 * device, and observe the events the device emits and the motor state it drives.
 * No scheduler is involved here — that's the integrator's gate; this proves the
 * device's local behaviour: it obeys clearance, reports markers + status, and
 * never moves without a grant.
 */
import {
  type CoreCommand,
  type CoreEvent,
  type Layout,
  PROTOCOL_VERSION,
} from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { buildNetwork } from '../physics/network.js';
import type { Rail } from '../physics/rail.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsMarkerSensor } from './marker-sensor.js';
import { physicsMotorActuator } from './motor-actuator.js';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';
import { ScheduledTrainDevice } from './scheduled-train-device.js';

const VERSION = PROTOCOL_VERSION;
const UUID = '11111111-1111-4111-8111-111111111111';
const TS = '1970-01-01T00:00:00.000Z';

/** A synthetic straight rail along +x. */
function straightRail(length: number): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

/* A three-marker layout strung along one straight rail: A(0) → B(500) → C(1000).
 * Marker ids double as their world x along the rail. */
const A_AT = 0;
const B_AT = 500;
const C_AT = 1000;
const MARKERS = [
  { id: 'M-A', x: A_AT, y: 0 },
  { id: 'M-B', x: B_AT, y: 0 },
  { id: 'M-C', x: C_AT, y: 0 },
];

const LAYOUT: Layout = {
  name: 'straight-3',
  markers: [
    { id: 'M-A', kind: 'block_boundary' },
    { id: 'M-B', kind: 'block_boundary' },
    { id: 'M-C', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M-A', to_marker_id: 'M-B', estimated_length_mm: 500 },
    { from_marker_id: 'M-B', to_marker_id: 'M-C', estimated_length_mm: 500 },
  ],
  junctions: [],
};

function world(): PhysicsWorld {
  const net = buildNetwork(new Map([['main', straightRail(1200)]]), []);
  const w = new PhysicsWorld(net);
  /* The loco starts at marker A (rail start), nose toward +x (forward). High
   *  power + cap so the nominal-speed dead reckoning and the world roughly agree
   *  over the short test runs. */
  w.addBody({ id: 'T1', kind: 'loco', segment: 'main', railPos: A_AT, facing: 1, maxSpeed: 400 });
  return w;
}

interface Rig {
  device: ScheduledTrainDevice;
  events: CoreEvent[];
  send(command: CoreCommand): void;
  run(steps: number, dt?: number): void;
  world: PhysicsWorld;
}

function rig(canReverse = true): Rig {
  const bus = new InProcessBus();
  const platform = inProcessPlatform(bus, 'T1');
  const w = world();
  const sensor = physicsMarkerSensor(w, 'T1', MARKERS);
  const device = new ScheduledTrainDevice('T1', {
    platform,
    motor: physicsMotorActuator(w, 'T1'),
    sensor,
    layout: LAYOUT,
    lengthMm: 120,
    canReverse,
    newId: () => UUID,
    now: () => TS,
  });
  const events: CoreEvent[] = [];
  bus.onEvent('T1', (e) => events.push(e));
  device.start();
  return {
    device,
    events,
    world: w,
    send: (command) => bus.sendCommand('T1', command),
    run: (steps, dt = 0.05) => {
      for (let i = 0; i < steps; i++) {
        w.step(dt);
        device.step(dt);
      }
    },
  };
}

function assignRoute(edges: { from_marker_id: string; to_marker_id: string }[]): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'T1',
    timestamp_server: TS,
    command_type: 'assign_route',
    protocol_version: VERSION,
    payload: { route_id: UUID, edges },
  };
}

function grantClearance(limit: string): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'T1',
    timestamp_server: TS,
    command_type: 'grant_clearance',
    protocol_version: VERSION,
    payload: { limit_marker_id: limit },
  };
}

function revokeClearance(): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'T1',
    timestamp_server: TS,
    command_type: 'revoke_clearance',
    protocol_version: VERSION,
    payload: { reason: 'test', immediate: true },
  };
}

function grantReverse(
  limit: string,
  edges: { from_marker_id: string; to_marker_id: string }[],
): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'T1',
    timestamp_server: TS,
    command_type: 'grant_reverse',
    protocol_version: VERSION,
    payload: { limit_marker_id: limit, edges },
  };
}

function setTargetSpeed(speed: number): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'T1',
    timestamp_server: TS,
    command_type: 'set_target_speed',
    protocol_version: VERSION,
    payload: { speed_normalised: speed },
  };
}

function emergencyStop(): CoreCommand {
  return {
    command_id: UUID,
    device_id: 'T1',
    timestamp_server: TS,
    command_type: 'emergency_stop',
    protocol_version: VERSION,
    payload: {},
  };
}

const ROUTE = [
  { from_marker_id: 'M-A', to_marker_id: 'M-B' },
  { from_marker_id: 'M-B', to_marker_id: 'M-C' },
];

const tagsObserved = (events: CoreEvent[]): string[] =>
  events
    .filter((e) => e.event_type === 'tag_observed')
    .map((e) => (e.payload as { tag_id: string }).tag_id);

describe('ScheduledTrainDevice — registration', () => {
  it('registers a manifest and a device_registered carrying its length + reverse capability', () => {
    const r = rig(true);
    const reg = r.events.filter((e) => e.event_type === 'device_registered');
    expect(reg).toHaveLength(1);
    const payload = reg[0]?.payload as { train_length_mm: number; capabilities: string[] };
    expect(payload.train_length_mm).toBe(120);
    expect(payload.capabilities).toContain('core.controls_motion');
    expect(payload.capabilities).toContain('core.can_reverse');
  });

  it('omits core.can_reverse when the loco cannot reverse', () => {
    const r = rig(false);
    const reg = r.events.find((e) => e.event_type === 'device_registered');
    const caps = (reg?.payload as { capabilities: string[] }).capabilities;
    expect(caps).not.toContain('core.can_reverse');
  });
});

describe('ScheduledTrainDevice — clearance, not commands', () => {
  it('stays stopped after assign_route until a grant arrives', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.run(10);
    expect(r.device.motion).toBe('stopped');
    expect(r.world.bodies().find((b) => b.id === 'T1')?.x).toBe(A_AT);
  });

  it('drives forward only once grant_clearance is received', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.send(grantClearance('M-B'));
    expect(r.device.motion).toBe('forward');
    r.run(40);
    const x = r.world.bodies().find((b) => b.id === 'T1')?.x ?? 0;
    expect(x).toBeGreaterThan(A_AT);
  });

  it('revoke_clearance stops the train and drops the limit', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.send(grantClearance('M-C'));
    r.run(5);
    r.send(revokeClearance());
    expect(r.device.motion).toBe('stopped');
  });

  it('emergency_stop halts the train', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.send(grantClearance('M-C'));
    r.run(3);
    r.send(emergencyStop());
    expect(r.device.motion).toBe('stopped');
  });
});

describe('ScheduledTrainDevice — marker reporting + self-stop at the limit', () => {
  it('publishes tag_observed as it crosses markers, and stops at the cleared limit', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.send(grantClearance('M-B'));
    /* Run long enough to reach B (500mm at ~ up to maxSpeed 400mm/s over 0.05s
     *  ticks). The sensor fires at B; the device stops there. */
    r.run(120);
    const tags = tagsObserved(r.events);
    expect(tags).toContain('M-B');
    /* It must NOT have run on past the limit to C. */
    expect(tags).not.toContain('M-C');
    expect(r.device.motion).toBe('stopped');
    const x = r.world.bodies().find((b) => b.id === 'T1')?.x ?? 0;
    expect(x).toBeLessThan(C_AT);
  });

  it('advances its route belief (current_edge) as it crosses the intermediate marker', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    expect(r.device.currentEdge).toEqual({ from_marker_id: 'M-A', to_marker_id: 'M-B' });
    /* Clear to B: the loco runs up to B, the sensor fires the crossing, the
     *  device advances its belief onto the B→C edge and self-stops at B. */
    r.send(grantClearance('M-B'));
    r.run(120);
    expect(r.device.motion).toBe('stopped');
    expect(r.device.currentEdge).toEqual({ from_marker_id: 'M-B', to_marker_id: 'M-C' });
  });

  it('emits train_status with the current edge + a dead-reckoned distance while running', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.send(grantClearance('M-C'));
    r.run(10);
    const status = r.events.filter((e) => e.event_type === 'train_status');
    expect(status.length).toBeGreaterThan(0);
    const last = status.at(-1)?.payload as {
      current_edge?: { from_marker_id: string };
      estimated_distance_from_edge_start_mm?: number;
      speed_normalised: number;
    };
    expect(last.current_edge?.from_marker_id).toBe('M-A');
    expect(last.estimated_distance_from_edge_start_mm ?? 0).toBeGreaterThan(0);
    expect(last.speed_normalised).toBeGreaterThan(0);
  });
});

describe('ScheduledTrainDevice — reverse only under grant_reverse', () => {
  it('never reverses on ordinary clearance', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.send(grantClearance('M-C'));
    r.run(20);
    expect(r.device.motion).toBe('forward');
  });

  it('reverses only when grant_reverse arrives (and the loco can reverse)', () => {
    const r = rig(true);
    r.send(assignRoute(ROUTE));
    r.send(grantReverse('M-A', [{ from_marker_id: 'M-B', to_marker_id: 'M-A' }]));
    expect(r.device.motion).toBe('reverse');
  });

  it('ignores grant_reverse when the loco cannot reverse', () => {
    const r = rig(false);
    r.send(assignRoute(ROUTE));
    r.send(grantReverse('M-A', [{ from_marker_id: 'M-B', to_marker_id: 'M-A' }]));
    expect(r.device.motion).toBe('stopped');
  });
});

describe('ScheduledTrainDevice — speed + lifecycle', () => {
  it('set_target_speed scales the reported speed_normalised', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.send(setTargetSpeed(0.5));
    r.send(grantClearance('M-C'));
    r.run(5);
    const status = r.events.filter((e) => e.event_type === 'train_status');
    const last = status.at(-1)?.payload as { speed_normalised: number };
    expect(last.speed_normalised).toBeCloseTo(0.5);
  });

  it('stops obeying commands after stop()', () => {
    const r = rig();
    r.send(assignRoute(ROUTE));
    r.device.stop();
    r.send(grantClearance('M-C'));
    expect(r.device.motion).toBe('stopped');
  });

  it('a marker crossing while running reports forward; re-crossing it backward reports reverse', () => {
    const r = rig(true);
    r.send(assignRoute(ROUTE));
    r.send(grantClearance('M-C'));
    /* Roll forward across B. */
    r.run(120);
    /* Back up: a reverse grant lets it retreat across B again, the other way. */
    r.send(grantReverse('M-A', [{ from_marker_id: 'M-B', to_marker_id: 'M-A' }]));
    r.run(120);
    const bReads = r.events
      .filter((e) => e.event_type === 'tag_observed')
      .filter((e) => (e.payload as { tag_id: string }).tag_id === 'M-B')
      .map((e) => (e.payload as { direction: string }).direction);
    expect(bReads).toContain('forward');
    expect(bReads).toContain('reverse');
  });
});
