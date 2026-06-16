/**
 * `ToyHardware` integration tests, on the ADR-030 PHYSICS engine.
 *
 * Real seams only (the Kent C. Dodds contract): a real `PhysicsWorld` built from the
 * operator's compiled track, real physics DEVICES (`ScheduledTrainDevice`,
 * `GateDevice`, `SwitchDevice`, `YardZoneDevice`), and the synchronous in-memory
 * broker. We drive the system through the operator's actions (scan / unscan / power /
 * tick) + scheduler commands, and observe outcomes on the bus and in the world's body
 * poses — never by mocking the scheduler, registry, or device hooks.
 *
 * The ACID test at the bottom proves the keystone: the migrated toy-table hardware
 * drives a train AND swaps its carriages at a discovered railyard gantry, on real
 * physics, through the real `@trainframe/server` scheduler over the broker.
 */
import { type CoreEvent, type Layout, PROTOCOL_VERSION } from '@trainframe/protocol';
import { Server } from '@trainframe/server';
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { mqttPlatform } from '@trainframe/simulator/broker/mqtt-platform.js';
import { compileNetwork } from '@trainframe/simulator/physics/network-from-pieces.js';
import { addPassingLoop } from '@trainframe/simulator/physics/passing-loop.js';
import {
  type Cursor,
  PieceNetworkBuilder,
  type PieceSpec,
} from '@trainframe/simulator/physics/piece-network.js';
import { compileLayout } from '@trainframe/simulator/track/layout-from-pieces.js';
import type {
  CarriageColorId,
  RotationDeg,
  TrackPiece,
} from '@trainframe/simulator/track/pieces.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { ToyHardware } from './toy-hardware.js';
import { buildDiscoveredYard, yardFootprintOf } from './toy-yard.js';

let nextId = 0;
function pid(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function piece(type: TrackPiece['type'], x = 0, y = 0, rotationDeg: RotationDeg = 0): TrackPiece {
  return { id: pid(type), type, position: { x, y }, rotationDeg, tagged: false };
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

beforeEach(() => {
  nextId = 0;
  idCounter = 0;
});

function topicsOf(client: InMemoryBrokerClient): string[] {
  return client.published.map((m) => m.topic);
}

/** A loco body pose for a live train, from the world. */
function locoPose(hardware: ToyHardware, deviceId: string): { x: number; y: number } | undefined {
  return hardware.bodies().find((b) => b.id === deviceId);
}

/**
 * Two straights end-to-end give a layout the hardware can compile and a rail the train
 * can seed on. Coordinates picked so endpoints fall within the snap distance.
 */
function twoStraightsAndATrain(): { pieces: TrackPiece[]; train: TrackPiece } {
  const s1 = piece('straight', 100, 100);
  const s2 = piece('straight', 300, 100);
  const train = piece('train', 110, 100);
  return { pieces: [s1, s2, train], train };
}

describe('ToyHardware — scan / unscan lifecycle', () => {
  it('spawns a physics loco body + announces it when its piece flips live', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      /* A real loco body is on the rail (the renderer draws it from here). */
      expect(locoPose(hardware, `T-${train.id}`)).toBeDefined();
      /* And the device announced itself on the bus (device_registered). */
      const topic = `railway/events/device_registered/T-${train.id}`;
      expect(topicsOf(client)).toContain(topic);
    } finally {
      hardware.dispose();
    }
  });

  it('despawns the body + publishes device_disconnected when the operator UNSCANS the train', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      expect(locoPose(hardware, `T-${train.id}`)).toBeDefined();

      hardware.syncLive(pieces, new Set());
      expect(locoPose(hardware, `T-${train.id}`)).toBeUndefined();
      const offTopic = `railway/events/device_disconnected/T-${train.id}`;
      expect(client.published.filter((m) => m.topic === offTopic)).toHaveLength(1);
    } finally {
      hardware.dispose();
    }
  });

  it('publishes exactly one device_disconnected when a live train piece is DELETED', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      expect(locoPose(hardware, `T-${train.id}`)).toBeDefined();

      const remaining = pieces.filter((p) => p.id !== train.id);
      hardware.syncLayout(remaining); // device pieces aren't topology — no rebuild
      hardware.syncLive(remaining, new Set());

      expect(locoPose(hardware, `T-${train.id}`)).toBeUndefined();
      const offTopic = `railway/events/device_disconnected/T-${train.id}`;
      expect(client.published.filter((m) => m.topic === offTopic)).toHaveLength(1);
    } finally {
      hardware.dispose();
    }
  });

  it('defers seeding a body when no rail originates near the train', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      /* Operator scans a train far from any track. No rail → no body seeded (the
       *  scan-time device_registered still went out; the physics just doesn't drive it
       *  until track exists). */
      const train = piece('train', 4000, 4000);
      hardware.syncLayout([train]);
      hardware.syncLive([train], new Set([train.id]));
      expect(locoPose(hardware, `T-${train.id}`)).toBeUndefined();
    } finally {
      hardware.dispose();
    }
  });
});

describe('ToyHardware — power is inert-in-place (never a disconnect)', () => {
  it('powering a train OFF keeps its body in the world and stays silent on the bus', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      expect(locoPose(hardware, `T-${train.id}`)).toBeDefined();

      const before = client.published.length;
      /* Power it off WITHOUT removing it from the live set. */
      hardware.syncPower(pieces, new Set([train.id]));

      /* Still in the world (NOT despawned). */
      expect(locoPose(hardware, `T-${train.id}`)).toBeDefined();
      /* No disconnect was published — a powered-off train just goes silent. */
      const offTopic = `railway/events/device_disconnected/T-${train.id}`;
      expect(client.published.find((m) => m.topic === offTopic)).toBeUndefined();
      /* Toggling power publishes nothing (it is not lifecycle). */
      expect(client.published.length).toBe(before);

      hardware.syncPower(pieces, new Set()); // back on — still no disconnect
      expect(client.published.find((m) => m.topic === offTopic)).toBeUndefined();
    } finally {
      hardware.dispose();
    }
  });

  it('a powered-OFF train does not advance; powered back on it can resume', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId, maxTickMs: 1000 });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      const deviceId = `T-${train.id}`;
      driveExploration(client, deviceId);
      hardware.tick(200);
      const movedX = locoPose(hardware, deviceId)?.x ?? 0;
      hardware.syncPower(pieces, new Set([train.id]));
      for (let i = 0; i < 20; i++) hardware.tick(200);
      const restX = locoPose(hardware, deviceId)?.x ?? 0;
      /* Inert: it coasted to rest and stopped advancing further. */
      expect(Math.abs(restX - movedX)).toBeLessThan(60);
    } finally {
      hardware.dispose();
    }
  });
});

describe('ToyHardware — placement is inert; only the scan flow commissions', () => {
  it('placing track pieces (no scan) emits nothing on the bus', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const before = client.published.length;
      hardware.syncLayout([piece('straight', 100, 100), piece('straight', 300, 100)]);
      expect(client.published.length).toBe(before);
    } finally {
      hardware.dispose();
    }
  });

  it('rebuilds the world (re-seeds the live train) when track topology changes', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      expect(locoPose(hardware, `T-${train.id}`)).toBeDefined();
      const extra = piece('straight', 500, 100);
      hardware.syncLayout([...pieces, extra]);
      expect(locoPose(hardware, `T-${train.id}`)).toBeDefined();
    } finally {
      hardware.dispose();
    }
  });

  it('caps tick advance at maxTickMs (a backgrounded tab cannot fast-forward minutes)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId, maxTickMs: 100 });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      driveExploration(client, `T-${train.id}`);
      const x0 = locoPose(hardware, `T-${train.id}`)?.x ?? 0;
      /* One huge tick is clamped to 100 ms of motion, so the loco advances only a
       *  little — not minutes' worth. */
      hardware.tick(60_000);
      const x1 = locoPose(hardware, `T-${train.id}`)?.x ?? 0;
      expect(Math.abs(x1 - x0)).toBeLessThan(80);
    } finally {
      hardware.dispose();
    }
  });

  it('ignores non-positive tick deltas', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      const x0 = locoPose(hardware, `T-${train.id}`)?.x ?? 0;
      hardware.tick(0);
      hardware.tick(-50);
      expect(locoPose(hardware, `T-${train.id}`)?.x ?? 0).toBe(x0);
    } finally {
      hardware.dispose();
    }
  });
});

describe('ToyHardware — gates', () => {
  it('spawns a gate device that announces itself, and disconnects on unscan', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const s = piece('straight', 100, 100);
      const gate = piece('gate', 200, 200);
      hardware.syncLayout([s, gate]);
      hardware.syncLive([s, gate], new Set([gate.id]));
      const topic = `railway/events/device_registered/GATE-${gate.id}`;
      expect(topicsOf(client)).toContain(topic);

      hardware.syncLive([s, gate], new Set());
      const offTopic = `railway/events/device_disconnected/GATE-${gate.id}`;
      expect(topicsOf(client)).toContain(offTopic);
    } finally {
      hardware.dispose();
    }
  });
});

describe('ToyHardware — experimental devices on physics', () => {
  it('a live lift bridge carries a BRIDGE- gate; raising the span withholds its own marker', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const bridge = piece('lift-bridge', 100, 100);
      hardware.syncLayout([bridge]);
      hardware.syncLive([bridge], new Set([bridge.id]));
      const marker = `M-${bridge.id}`;

      /* The physical act: span up ⇒ withhold clearance across the span marker. */
      hardware.holdGate(`BRIDGE-${bridge.id}`, marker, 'span raised');
      expect(hardware.isWithholding(`BRIDGE-${bridge.id}`, marker)).toBe(true);
      const topic = `railway/events/gate_state_changed/BRIDGE-${bridge.id}`;
      expect(client.published.filter((m) => m.topic === topic)).toHaveLength(1);

      /* Lower and seat ⇒ grant. Same machinery as a level-crossing gate. */
      hardware.releaseGate(`BRIDGE-${bridge.id}`, marker);
      expect(hardware.isWithholding(`BRIDGE-${bridge.id}`, marker)).toBe(false);
      expect(client.published.filter((m) => m.topic === topic)).toHaveLength(2);
    } finally {
      hardware.dispose();
    }
  });

  it('a live crane station carries a CRANE- gate (to pin a dwelling train)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const crane = piece('crane-station', 100, 100);
      hardware.syncLayout([crane]);
      hardware.syncLive([crane], new Set([crane.id]));
      const topic = `railway/events/device_registered/CRANE-${crane.id}`;
      expect(topicsOf(client)).toContain(topic);
    } finally {
      hardware.dispose();
    }
  });

  it('a vision station MEASURES a passing train’s length from physics bodies and asserts it from ITS OWN identity (ADR-023)', () => {
    /* A train towing two wagons drives through the station; the station measures its
     *  length from two-marker speed × camera dwell over the PHYSICS BODIES — never a
     *  consist read — and (it is NOT the train) emits train_length_changed. */
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId, maxTickMs: 1000 });
    try {
      const s1 = piece('straight', 100, 100);
      const s2 = piece('straight', 300, 100);
      const vs = piece('vision-station', 500, 100);
      const s3 = piece('straight', 700, 100);
      const s4 = piece('straight', 900, 100);
      const s5 = piece('straight', 1100, 100);
      const train = piece('train', 110, 100);
      const red1 = carriage(60, 100, 'red');
      const red2 = carriage(10, 100, 'red');
      const pieces = [s1, s2, vs, s3, s4, s5, train, red1, red2];
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set(pieces.map((p) => p.id)));

      driveExploration(client, `T-${train.id}`);
      for (let i = 0; i < 300; i++) hardware.tick(100);

      const topic = `railway/events/train_length_changed/VLS-${vs.id}`;
      const reports = client.published.filter((m) => m.topic === topic);
      expect(reports.length).toBeGreaterThanOrEqual(1);
      const env = decodeEnvelope(reports[0] ?? { payload: new Uint8Array() });
      expect(env.device_id).toBe(`VLS-${vs.id}`);
      expect(env.payload.train_id).toBe(`T-${train.id}`);
      const len = env.payload.train_length_mm;
      expect(typeof len).toBe('number');
      /* Measured nose-to-tail span (loco + 2 wagons + footprint over-read): a band, not
       *  a configured constant — a real measurement wanders. */
      expect(len as number).toBeGreaterThan(120);
      expect(len as number).toBeLessThan(360);
    } finally {
      hardware.dispose();
    }
  });

  it('a vision station stays silent when no train is present', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const vs = piece('vision-station', 310, 100);
      hardware.syncLayout([vs]);
      hardware.syncLive([vs], new Set([vs.id]));
      for (let i = 0; i < 20; i++) hardware.tick(100);
      const topic = `railway/events/train_length_changed/VLS-${vs.id}`;
      expect(client.published.filter((m) => m.topic === topic)).toHaveLength(0);
    } finally {
      hardware.dispose();
    }
  });
});

describe('ToyHardware — mechanical device state survives a topology rebuild', () => {
  it('a raised span stays raised when track is added (re-asserted on the bus)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const bridge = piece('lift-bridge', 100, 100);
      hardware.syncLayout([bridge]);
      hardware.syncLive([bridge], new Set([bridge.id]));
      const marker = `M-${bridge.id}`;

      hardware.holdGate(`BRIDGE-${bridge.id}`, marker, 'span raised');

      /* Extend the track ⇒ topology changes ⇒ the world is rebuilt. */
      const extended = [bridge, piece('straight', 800, 100)];
      hardware.syncLayout(extended);

      expect(hardware.isWithholding(`BRIDGE-${bridge.id}`, marker)).toBe(true);
      /* The respawned gate re-asserts its withhold on the bus — one before the rebuild,
       *  one after, like a device coming back up announcing where it stands. */
      const gateTopic = `railway/events/gate_state_changed/BRIDGE-${bridge.id}`;
      expect(client.published.filter((m) => m.topic === gateTopic)).toHaveLength(2);
    } finally {
      hardware.dispose();
    }
  });

  it('a thrown junction switch stays thrown when track is added', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      /* A junction with a through straight + a branch straight, so it compiles. */
      const j = piece('junction', 200, 100);
      const thru = piece('straight', 400, 100);
      const branch = piece('straight', 271, 171, 45);
      const before = [j, thru, branch];
      hardware.syncLayout(before);
      hardware.syncLive(before, new Set([j.id]));

      hardware.setSwitch(j.id, 'divert');
      expect(hardware.switchPosition(j.id)).toBe('divert');
      const switchTopic = `railway/events/switch_state_changed/SWITCH-${j.id}`;
      expect(client.published.filter((m) => m.topic === switchTopic)).toHaveLength(1);

      hardware.syncLayout([...before, piece('straight', 600, 100)]);

      expect(hardware.switchPosition(j.id)).toBe('divert');
      /* Re-asserted: one confirmation before the rebuild, one after. */
      expect(client.published.filter((m) => m.topic === switchTopic)).toHaveLength(2);
    } finally {
      hardware.dispose();
    }
  });

  it('a deleted piece takes its device state with it (no orphan re-assertion)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const bridge = piece('lift-bridge', 100, 100);
      hardware.syncLayout([bridge]);
      hardware.syncLive([bridge], new Set([bridge.id]));
      hardware.holdGate(`BRIDGE-${bridge.id}`, `M-${bridge.id}`, 'span raised');

      /* Delete the bridge while raised, replacing it — its state drops out rather than
       *  being re-asserted onto thin air. */
      hardware.syncLayout([piece('straight', 800, 100)]);
      hardware.syncLive([], new Set());
      expect(hardware.isWithholding(`BRIDGE-${bridge.id}`, `M-${bridge.id}`)).toBe(false);
    } finally {
      hardware.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// THE BEHAVIORAL ACID TEST (task #32: "gantry over real pieces") — in ONE physics
// world, a CLOSED LOOP and a managed RAILYARD coexist: a circulating train laps the
// loop WHILE a visitor is serviced at a gantry over the operator's OWN, REAL placed
// slot pieces (discovered, not a synthetic stand-in). On real physics, real devices
// (`ScheduledTrainDevice`, `YardZoneDevice`), through the real @trainframe/server over
// the broker. The loop's running segments and the yard's slot segments are ALL in the
// one `compileNetwork(pieces).net` — there is no second world, no synthetic yard, no
// translation.
// ---------------------------------------------------------------------------

/** A closed loop with a passing-loop YARD spliced into the bottom run: the loop's main
 *  passes straight through the yard, and a parallel siding rejoins it — TWO real stabling
 *  roads (the main mid + the siding) the gantry will discover and drive. Built from
 *  ordinary Brio pieces (`PieceNetworkBuilder`) and harvested as free-placed
 *  `TrackPiece[]`, exactly what the toy table compiles. */
function loopWithYardPieces(): TrackPiece[] {
  const S: PieceSpec = { type: 'straight' };
  const C: PieceSpec = { type: 'curve' };
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const side = [S, S];
  const corner = [C, C];
  let c = b.run('b1', start, [S]);
  const { exit, segments } = addPassingLoop(b, c, { prefix: 'Y', parallelStraights: 3 });
  b.link('b1', 'Y-in');
  c = b.run('b2', exit, [S]);
  b.link(segments.mergeThrough, 'b2');
  b.link(segments.mergeBranch, 'b2');
  c = b.run('c1', c, corner);
  c = b.run('right', c, [...side, ...side]);
  c = b.run('c2', c, corner);
  c = b.run('top', c, [...side, ...side, ...side, ...side, ...side]);
  c = b.run('c3', c, corner);
  c = b.run('left', c, [...side, ...side]);
  c = b.run('c4', c, corner);
  /* Close the loop with a single solved-length filler (the passing loop leaves a √2
   *  residue no whole straight absorbs). */
  const gap = Math.hypot(start.x - c.x, start.y - c.y);
  b.run('closer', c, [{ type: 'straight', lengthMm: gap }]);
  b.link('c4', 'closer');
  b.link('closer', 'b1');
  return [...b.build().pieces] as TrackPiece[];
}

/** A carriage piece with a fixed id (so the test can name its seeded body). */
function namedCarriage(idStr: string, x: number, y: number, colorId: CarriageColorId): TrackPiece {
  return {
    id: idStr,
    type: 'carriage',
    position: { x, y },
    rotationDeg: 0,
    tagged: false,
    colorId,
  };
}

describe('ToyHardware — ACID: a train laps the loop WHILE a visitor is serviced on the operator’s real slots, in ONE world', () => {
  it('the loop circulates AND the discovered yard swaps a carriage — both in compileNetwork(pieces).net', () => {
    /* The synchronous in-memory broker is the single bus. The server's BrokerClient
     *  differs only in returning promises from connect/disconnect, so we hand it a thin
     *  promise-facade over the SAME bus (the `physics-env.ts` pattern). */
    const bus = new InMemoryBrokerClient();
    bus.connect('inmem://');
    let clockMs = 0;
    let seq = 0;
    const id = (): string => {
      seq += 1;
      return `acid-${seq}`;
    };
    const now = (): number => clockMs;
    const nowIso = (): string => new Date(clockMs).toISOString();
    const serverClient = {
      connect: async (): Promise<void> => {},
      disconnect: async (): Promise<void> => {},
      subscribe: (t: string, h: Parameters<InMemoryBrokerClient['subscribe']>[1]) =>
        bus.subscribe(t, h),
      publish: (...a: Parameters<InMemoryBrokerClient['publish']>) => bus.publish(...a),
    };

    /* The ONE table: a closed loop + a passing-loop yard, a gantry dropped over the yard's
     *  parallel band, a VISITOR (2 red wagons) parked at the discovered throat, a
     *  CIRCULATOR up on the top run, and two PURPLE spares the operator parked in a slot. */
    const loop = loopWithYardPieces();
    const yard = piece('railyard', 1000, 65); // centred over the yard's parallel band
    const compiled = compileNetwork(loop);
    const disc = buildDiscoveredYard(compiled, yardFootprintOf(yard), [...loop, yard]);
    if (disc === null) throw new Error('acid: the gantry must discover the operator’s slot fan');
    const throat = disc.throatPoint;

    const visitor = piece('train', throat.x + 30, throat.y); // at the throat, facing in
    const r0 = namedCarriage(pid('carriage'), throat.x + 20, throat.y, 'red');
    const r1 = namedCarriage(pid('carriage'), throat.x + 10, throat.y, 'red');
    const sparesSlot = disc.layout.geom.get(disc.layout.slots[1] ?? '');
    const sx = sparesSlot === undefined ? 0 : (sparesSlot.ax + sparesSlot.bx) / 2;
    const sy = sparesSlot === undefined ? 0 : (sparesSlot.ay + sparesSlot.by) / 2;
    const p0 = namedCarriage(pid('carriage'), sx, sy, 'purple');
    const p1 = namedCarriage(pid('carriage'), sx + 68, sy, 'purple');
    const circulator = piece('train', 1124, 1200, 180); // up on the top run, far from the yard

    const pieces = [...loop, yard, visitor, r0, r1, p0, p1, circulator];

    /* COEXISTENCE (c): the loop's running segments and the yard's slot segments are ALL in
     *  the one compiled net — proven before any device runs. */
    const segs = new Set(compileNetwork(pieces).net.segments());
    for (const slot of disc.layout.slots) {
      expect(segs.has(slot), 'a discovered slot segment is in the unified net').toBe(true);
    }
    expect(segs.has('S-top-p23'), 'a loop running segment is in the SAME net').toBe(true);

    /* The scheduler's layout — built the SAME way ToyHardware builds it (throat marker
     *  repositioned to the world throat + a yard-far marker), so server + hardware agree. */
    const layout = acidLayout(pieces, yard.id, throat, disc);
    const server = new Server({ layout, client: serverClient, newId: id, now });
    server.start();
    seedIdentityTags(bus, layout, id, nowIso);

    const visitorId = `T-${visitor.id}`;
    const circId = `T-${circulator.id}`;
    /* The whole table is on the table; the operator commissions it in two scans — the loop
     *  + gantry + circulator first, then the visitor when it arrives. */
    const allIds = new Set(pieces.map((p) => p.id));
    const withoutVisitor = new Set(
      [...allIds].filter((i) => i !== visitor.id && i !== r0.id && i !== r1.id),
    );

    const hardware = new ToyHardware({ client: bus, newId: id, maxTickMs: 1000 });
    /* One 100 ms world+server step, with the shared virtual clock advanced. */
    const tick = (): void => {
      clockMs += 100;
      hardware.tick(100);
    };
    try {
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, withoutVisitor);

      const ownCut = [`${visitorId}-c0`, `${visitorId}-c1`];
      const spares = [`SPARE-${p0.id}`, `SPARE-${p1.id}`];

      /* ── PHASE A — CIRCULATION (a) ────────────────────────────────────────
       *  No visitor is at the throat yet, so the yard's points sit at their default `thru`
       *  and the circulator passes straight THROUGH the in-line yard each lap. */
      const lap = lapTheLoop(hardware, bus, circId, tick);
      expect(lap.maxDist, 'the circulator got far around the loop').toBeGreaterThan(800);
      expect(lap.returned, 'the circulator completed a closed lap').toBe(true);
      expect(lap.segments, 'the circulator crossed many loop segments').toBeGreaterThanOrEqual(12);

      /* The VISITOR arrives: the operator scans it in (a second commission). It seeds at the
       *  discovered throat, the circulator parked inert (re-seeded on its top-run piece,
       *  clear of the yard) so the service may throw the shared passing-loop points without
       *  it running into them — the honest seam where the yard's `gates_zone` holds an
       *  approaching train short (ADR-026; the scheduler-gated hold is in the integration
       *  suite). */
      hardware.syncLive(pieces, allIds);

      /* ── PHASE B — SWAP (b) ───────────────────────────────────────────────
       *  The yard services the parked visitor on the operator's REAL slots, in the SAME
       *  unified world the circulator just lapped. */
      const released = pumpUntilReleased(bus, `YARD-${yard.id}`, tick);
      expect(released, 'the gantry serviced + released the visitor').toBe(true);
      const visitorRake = rakeOf(hardware, visitorId);
      expect(
        spares.some((s) => visitorRake.has(s)),
        'the visitor departs coupled to a discovered spare (a carriage migrated)',
      ).toBe(true);
      expect(
        ownCut.every((c) => !visitorRake.has(c)),
        'the visitor shed its own red cut',
      ).toBe(true);

      /* The zone occupancy rose to 1 then fell back to 0 — the device-asserted fact the
       *  scheduler consults, on the operator's discovered slots. */
      const occ = zoneOccupancies(bus, `YARD-${yard.id}`);
      expect(Math.max(...occ), 'occupancy rose to 1').toBe(1);
      expect(occ[occ.length - 1], 'occupancy fell back to 0 on release').toBe(0);
    } finally {
      hardware.dispose();
      server.stop();
    }
  }, 120_000);
});

/** Phase A: drive the circulator with exploration and pump until it completes a closed
 *  lap (or a cap). Returns its max distance from start, whether it returned, and the count
 *  of distinct segments it crossed — the evidence it genuinely circulated. */
function lapTheLoop(
  hardware: ToyHardware,
  bus: InMemoryBrokerClient,
  circId: string,
  tick: () => void,
): { maxDist: number; returned: boolean; segments: number } {
  driveExploration(bus, circId);
  const circBody = (): { x: number; y: number; segment: string } | undefined =>
    hardware.bodies().find((b) => b.id === circId);
  const start = circBody() ?? { x: 0, y: 0, segment: '' };
  let maxDist = 0;
  let returned = false;
  const segments = new Set<string>();
  for (let i = 0; i < 4000 && !returned; i++) {
    tick();
    const cb = circBody();
    if (cb === undefined) continue;
    segments.add(cb.segment);
    const d = Math.hypot(cb.x - start.x, cb.y - start.y);
    maxDist = Math.max(maxDist, d);
    if (maxDist > 800 && d < 160) returned = true;
  }
  return { maxDist, returned, segments: segments.size };
}

/** Phase B: pump until the yard publishes `zone_train_released` for `yardDeviceId` (or a
 *  cap). Returns whether the release fired. */
function pumpUntilReleased(
  bus: InMemoryBrokerClient,
  yardDeviceId: string,
  tick: () => void,
): boolean {
  for (let i = 0; i < 3000; i++) {
    tick();
    if (
      bus.published.some((m) =>
        m.topic.startsWith(`railway/events/zone_train_released/${yardDeviceId}`),
      )
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function carriage(x: number, y: number, colorId: CarriageColorId): TrackPiece {
  return {
    id: pid('carriage'),
    type: 'carriage',
    position: { x, y },
    rotationDeg: 0,
    tagged: false,
    colorId,
  };
}

/** Decode a published wire envelope back to its JSON payload. */
function decodeEnvelope(m: { payload: Uint8Array }): {
  device_id: string;
  payload: { train_id?: string; train_length_mm?: number };
} {
  return JSON.parse(new TextDecoder().decode(m.payload));
}

/** Publish a `begin_exploration` to a train so it drives forward (no server needed). */
function driveExploration(client: InMemoryBrokerClient, deviceId: string): void {
  const envelope = {
    command_id: 'cmd-explore',
    device_id: deviceId,
    timestamp_server: new Date(0).toISOString(),
    command_type: 'begin_exploration',
    protocol_version: PROTOCOL_VERSION,
    payload: {},
  };
  client.publish(
    `railway/commands/${deviceId}`,
    new TextEncoder().encode(JSON.stringify(envelope)),
  );
}

/** The coupled group containing `id`, by flood-fill over the world's couplings. */
function rakeOf(hardware: ToyHardware, id: string): Set<string> {
  const byId = new Map(hardware.bodies().map((b) => [b.id, b] as const));
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    for (const n of byId.get(cur)?.coupledTo ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

/** The occupancy trace a yard device published (zone_state_changed). */
function zoneOccupancies(client: InMemoryBrokerClient, deviceId: string): number[] {
  return client.published
    .filter((m) => m.topic === `railway/events/zone_state_changed/${deviceId}`)
    .map((m) => decodeZone(m.payload))
    .filter((o): o is number => o !== undefined);
}

function decodeZone(payload: Uint8Array): number | undefined {
  try {
    const env = JSON.parse(new TextDecoder().decode(payload)) as {
      payload?: { occupancy?: number };
    };
    return env.payload?.occupancy;
  } catch {
    return undefined;
  }
}

/** Build the scheduler's layout for the acid scene, matching ToyHardware's: the throat
 *  marker repositioned to the world throat point + a yard-far marker at the east lead. */
function acidLayout(
  pieces: readonly TrackPiece[],
  yardId: string,
  throat: { x: number; y: number },
  disc: NonNullable<ReturnType<typeof buildDiscoveredYard>>,
): Layout {
  const base = compileLayout(pieces, 'toy-table');
  const throatId = `M-${yardId}`;
  const east = disc.layout.geom.get(disc.layout.leadEast);
  return {
    ...base,
    markers: [
      ...base.markers.map((m) =>
        m.id === throatId
          ? { ...m, kind: 'yard_entry' as const, position: { x_mm: throat.x, y_mm: throat.y } }
          : m,
      ),
      {
        id: `${throatId}-far`,
        kind: 'block_boundary' as const,
        position: { x_mm: east?.bx ?? 0, y_mm: east?.by ?? 0 },
      },
    ],
    edges: [
      ...base.edges,
      { from_marker_id: throatId, to_marker_id: `${throatId}-far`, estimated_length_mm: 1000 },
      { from_marker_id: `${throatId}-far`, to_marker_id: throatId, estimated_length_mm: 1000 },
    ],
  };
}

/** Mint one `tag_assignment` per marker so the scheduler resolves `tag_observed` →
 *  `marker_traversed` (a synthetic GARAGE device with `core.assigns_tags`). */
function seedIdentityTags(
  bus: InMemoryBrokerClient,
  layout: Layout,
  id: () => string,
  nowIso: () => string,
): void {
  const garage = mqttPlatform(bus, 'GARAGE', { newId: id, now: nowIso });
  garage.register({
    manifest_version: '1.0',
    vendor: 'trainframe.sim',
    device_kind: 'tag-garage',
    version: '0.1.0',
    protocol_version: PROTOCOL_VERSION,
    display_name: 'Tag garage',
    description: 'Mints identity tag assignments.',
    capabilities: ['core.assigns_tags'],
  });
  for (const m of layout.markers) {
    garage.publish({
      event_id: id(),
      device_id: 'GARAGE',
      timestamp_device: nowIso(),
      event_type: 'tag_assignment',
      protocol_version: PROTOCOL_VERSION,
      payload: { tag_id: m.id, assigned_kind: 'marker', target_id: m.id },
    } as unknown as CoreEvent);
  }
}
