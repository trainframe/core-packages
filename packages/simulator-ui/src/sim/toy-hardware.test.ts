import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import type { CarriageColorId, RotationDeg, TrackPiece } from '../track/pieces.js';
import { ToyHardware } from './toy-hardware.js';

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

/**
 * Two straights end-to-end give us a layout the hardware can compile and a
 * marker the train can start on. Coordinates picked so endpoints fall within
 * the snap distance (30mm) used by `compileLayout`.
 */
function twoStraightsAndATrain(): { pieces: TrackPiece[]; train: TrackPiece } {
  const s1 = piece('straight', 100, 100);
  const s2 = piece('straight', 300, 100);
  const train = piece('train', 110, 100);
  return { pieces: [s1, s2, train], train };
}

describe('ToyHardware', () => {
  it('spawns a virtual train when its piece flips live', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      const sim = hardware.getSimulation();
      expect(sim.getTrain(`T-${train.id}`)).toBeDefined();
    } finally {
      hardware.dispose();
    }
  });

  it('despawns the train when the operator UNSCANS it (drops it from the live set)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      // Leaving the live set is a genuine despawn (unscan / delete path): the
      // train is removed from the sim and `device_disconnected` is published.
      hardware.syncLive(pieces, new Set());
      const sim = hardware.getSimulation();
      expect(sim.getTrain(`T-${train.id}`)).toBeUndefined();
      const offTopic = `railway/events/device_disconnected/T-${train.id}`;
      expect(client.published.filter((m) => m.topic === offTopic)).toHaveLength(1);
    } finally {
      hardware.dispose();
    }
  });

  it('publishes exactly one device_disconnected when a live train piece is DELETED', () => {
    /* Delete removes the piece from `pieces` and the live set in the same
     * render, so the despawn must resolve the piece via the previous snapshot
     * — and still disconnect exactly once (the sim's own despawn event is the
     * only publish; no doubled direct publish). */
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      expect(hardware.getSimulation().getTrain(`T-${train.id}`)).toBeDefined();

      const remaining = pieces.filter((p) => p.id !== train.id);
      hardware.syncLayout(remaining); // device pieces aren't topology — no rebuild
      hardware.syncLive(remaining, new Set());

      expect(hardware.getSimulation().getTrain(`T-${train.id}`)).toBeUndefined();
      const offTopic = `railway/events/device_disconnected/T-${train.id}`;
      expect(client.published.filter((m) => m.topic === offTopic)).toHaveLength(1);
    } finally {
      hardware.dispose();
    }
  });

  it('publishes exactly one device_disconnected when a deleted train never spawned (no track)', () => {
    /* A train scanned with no track near it defers its sim spawn, but its
     * device_registered already went out at scan time — deleting it must
     * still announce the departure on the wire. */
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const train = piece('train', 100, 100);
      hardware.syncLayout([train]);
      hardware.syncLive([train], new Set([train.id]));
      expect(hardware.getSimulation().getTrain(`T-${train.id}`)).toBeUndefined();

      hardware.syncLive([], new Set());

      const offTopic = `railway/events/device_disconnected/T-${train.id}`;
      expect(client.published.filter((m) => m.topic === offTopic)).toHaveLength(1);
    } finally {
      hardware.dispose();
    }
  });

  it('powering a train OFF in place keeps it spawned, inert, and silent (no device_disconnected)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      const sim = hardware.getSimulation();
      const simTrain = sim.getTrain(`T-${train.id}`);
      expect(simTrain).toBeDefined();
      if (simTrain === undefined) throw new Error('unreachable');

      // Power it off WITHOUT removing it from the live set — it stays on the
      // track, frozen at its position.
      hardware.syncPower(pieces, new Set([train.id]));

      // Still in the sim (NOT despawned).
      expect(sim.getTrain(`T-${train.id}`)).toBe(simTrain);
      expect(simTrain.isPowered()).toBe(false);
      // No disconnect was published — a powered-off train just goes silent.
      const offTopic = `railway/events/device_disconnected/T-${train.id}`;
      expect(client.published.find((m) => m.topic === offTopic)).toBeUndefined();

      // Power back on resumes it.
      hardware.syncPower(pieces, new Set());
      expect(simTrain.isPowered()).toBe(true);
    } finally {
      hardware.dispose();
    }
  });

  it('publishes spawn-time events through the broker bridge', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      const topic = `railway/events/device_registered/T-${train.id}`;
      const published = client.published.find((m) => m.topic === topic);
      expect(published).toBeDefined();
    } finally {
      hardware.dispose();
    }
  });

  it('defers spawning when the layout has no track at all', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      // Operator scans a train before laying any track. The layout has no
      // markers, so `nearestStartEdge` returns undefined and the simulation
      // defers spawning — the broker still hears the scan-time
      // `device_registered` from ToyTable, but the physics sim doesn't drive
      // it until track exists.
      const train = piece('train', 100, 100);
      hardware.syncLayout([train]);
      hardware.syncLive([train], new Set([train.id]));
      const sim = hardware.getSimulation();
      expect(sim.getTrain(`T-${train.id}`)).toBeUndefined();
    } finally {
      hardware.dispose();
    }
  });

  it('rebuilds the simulation when track topology changes', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      const before = hardware.getSimulation();
      hardware.syncLayout(pieces);
      expect(hardware.getSimulation()).toBe(before);
      const extra = piece('straight', 500, 100);
      hardware.syncLayout([...pieces, extra]);
      expect(hardware.getSimulation()).not.toBe(before);
    } finally {
      hardware.dispose();
    }
  });

  it('re-spawns live trains after a topology rebuild', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      // Add a piece — topology changes, sim is rebuilt.
      const extra = piece('straight', 500, 100);
      const all = [...pieces, extra];
      hardware.syncLayout(all);
      hardware.syncLive(all, new Set([train.id]));
      expect(hardware.getSimulation().getTrain(`T-${train.id}`)).toBeDefined();
    } finally {
      hardware.dispose();
    }
  });

  it('spawns and despawns gates', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const s = piece('straight', 100, 100);
      const gate = piece('gate', 200, 200);
      hardware.syncLayout([s, gate]);
      hardware.syncLive([s, gate], new Set([gate.id]));
      // Gate emits its own device_registered through the bridge.
      const topic = `railway/events/device_registered/GATE-${gate.id}`;
      expect(client.published.find((m) => m.topic === topic)).toBeDefined();

      hardware.syncLive([s, gate], new Set());
      const offTopic = `railway/events/device_disconnected/GATE-${gate.id}`;
      expect(client.published.find((m) => m.topic === offTopic)).toBeDefined();
    } finally {
      hardware.dispose();
    }
  });

  it('caps tick advance at maxTickMs', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId, maxTickMs: 100 });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      const before = hardware.getSimulation().clock.now();
      hardware.tick(60_000);
      const elapsed = hardware.getSimulation().clock.now() - before;
      expect(elapsed).toBe(100);
    } finally {
      hardware.dispose();
    }
  });

  it('placing track pieces (no scan) emits nothing on the bus', () => {
    // Placement is a physical act, like dropping a piece on a real table.
    // It must not generate any wire traffic — commissioning happens only
    // through the scan-box flow (ToyTable.scanPiece). ToyHardware mirrors
    // bindings into the in-browser Simulation silently via bindIdentityTag,
    // not via the publishing seedIdentityTags.
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

  it('scanning a track piece silently mirrors the binding into the Simulation', () => {
    // The scan-flow's tag_assignment already fires from ToyTable; ToyHardware
    // just needs the in-process markerToTag map populated so trains emit
    // tag_observed for the right marker. No additional wire publish.
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const s1 = piece('straight', 100, 100);
      hardware.syncLayout([s1]);
      const before = client.published.length;
      hardware.syncLive([s1], new Set([s1.id]));
      expect(client.published.length).toBe(before);
      // The marker→tag map now has an entry for this piece. The cheapest
      // observation: spawnTrain over the same marker emits tag_observed.
      // (The verification proper happens in the broker-bridge integration
      // tests; here we just assert the bind happened by spawning a probe.)
      const sim = hardware.getSimulation();
      sim.spawnTrain('PROBE', {
        startEdge: { from_marker_id: `M-${s1.id}`, to_marker_id: `M-${s1.id}` },
      });
      // No assertion beyond construction — spawnTrain wouldn't accept a
      // marker the LayoutState doesn't know, so the fact that it didn't
      // throw confirms the layout has `M-{s1.id}` registered.
    } finally {
      hardware.dispose();
    }
  });

  it('ignores non-positive tick deltas', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const before = hardware.getSimulation().clock.now();
      hardware.tick(0);
      hardware.tick(-50);
      expect(hardware.getSimulation().clock.now()).toBe(before);
    } finally {
      hardware.dispose();
    }
  });
});

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

describe('ToyHardware — railyard + carriage consists', () => {
  /**
   * Two straights + a train towing two red wagons, with a railyard beside the
   * far marker holding two purple spares. Exercises the wire-faithful seam: the
   * railyard becomes a gates_zone device gating the nearest marker, the train's
   * sim consist is seeded from proximity, and the carriages by the yard become
   * its spares.
   */
  function railyardScene() {
    const s1 = piece('straight', 100, 100);
    const s2 = piece('straight', 300, 100);
    const train = piece('train', 110, 100);
    const red1 = carriage(60, 100, 'red');
    const red2 = carriage(10, 100, 'red');
    const railyard = piece('railyard', 300, 170);
    const purple1 = carriage(280, 210, 'purple');
    const purple2 = carriage(320, 210, 'purple');
    const pieces = [s1, s2, train, red1, red2, railyard, purple1, purple2];
    return { pieces, s2, train, railyard, red1, red2, purple1, purple2 };
  }

  it('spawns a gates_zone railyard on the nearest marker and seeds consist + spares', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const scene = railyardScene();
      const live = new Set(scene.pieces.map((p) => p.id));
      hardware.syncLayout(scene.pieces);
      hardware.syncLive(scene.pieces, live);

      const sim = hardware.getSimulation();
      const yard = sim.getRailyard(`YARD-${scene.railyard.id}`);
      expect(yard).toBeDefined();
      // The throat is the marker nearest the shed (the far straight, M-s2).
      expect(yard?.throatMarkerId).toBe(`M-${scene.s2.id}`);

      // The train's consist is seeded from proximity: its two red wagons.
      const consist = sim.getTrain(`T-${scene.train.id}`)?.getConsist() ?? [];
      expect(consist.map((c) => c.id).sort()).toEqual([scene.red1.id, scene.red2.id].sort());

      // The carriages by the shed (claimed by no train) are the yard's spares.
      expect((yard?.getSpares() ?? []).map((c) => c.id).sort()).toEqual(
        [scene.purple1.id, scene.purple2.id].sort(),
      );
    } finally {
      hardware.dispose();
    }
  });

  it('preserves a railyard swap across re-syncs (composition unchanged → no reseed)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const scene = railyardScene();
      const live = new Set(scene.pieces.map((p) => p.id));
      hardware.syncLayout(scene.pieces);
      hardware.syncLive(scene.pieces, live);

      const sim = hardware.getSimulation();
      const yard = sim.getRailyard(`YARD-${scene.railyard.id}`);
      const train = sim.getTrain(`T-${scene.train.id}`);
      if (yard === undefined || train === undefined) throw new Error('scene not spawned');

      // The yard shunts: the train's leading pair (red) swaps for the purple
      // spares. The sim consist now leads with purple.
      yard.swapLeadingPair(train);
      expect(train.getConsist().every((c) => c.colorId === 'purple')).toBe(true);

      // A subsequent render re-syncs with the SAME pieces. The composition is
      // unchanged, so the hardware must NOT reseed from proximity and clobber
      // the swap — the train keeps its purple wagons.
      hardware.syncLive(scene.pieces, live);
      expect(
        sim
          .getTrain(`T-${scene.train.id}`)
          ?.getConsist()
          .every((c) => c.colorId === 'purple'),
      ).toBe(true);
    } finally {
      hardware.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Experimental devices (docs/experimental 001–005) — wire-faithful seams
// ---------------------------------------------------------------------------

/** Decode a published wire envelope back to its JSON payload. */
function decodeEnvelope(m: { payload: Uint8Array }): {
  device_id: string;
  payload: { train_id?: string; train_length_mm?: number };
} {
  return JSON.parse(new TextDecoder().decode(m.payload));
}

describe('ToyHardware — experimental devices', () => {
  it('a live lift bridge carries a BRIDGE- gate; raising the span withholds its own marker', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const bridge = piece('lift-bridge', 100, 100);
      hardware.syncLayout([bridge]);
      hardware.syncLive([bridge], new Set([bridge.id]));

      const gate = hardware.getSimulation().getGate(`BRIDGE-${bridge.id}`);
      expect(gate).toBeDefined();
      if (gate === undefined) throw new Error('unreachable');

      // The physical act: span up ⇒ withhold clearance across the span marker.
      gate.withhold(`M-${bridge.id}`, 'span raised');
      expect(gate.isWithholding(`M-${bridge.id}`)).toBe(true);
      const topic = `railway/events/gate_state_changed/BRIDGE-${bridge.id}`;
      expect(client.published.filter((m) => m.topic === topic)).toHaveLength(1);

      // Lower and seat ⇒ grant. Same machinery as a level-crossing gate.
      gate.release(`M-${bridge.id}`);
      expect(gate.isWithholding(`M-${bridge.id}`)).toBe(false);
      expect(client.published.filter((m) => m.topic === topic)).toHaveLength(2);
    } finally {
      hardware.dispose();
    }
  });

  it('a live crane station carries a CRANE- gate (to pin a dwelling train, never a dwell timer)', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const crane = piece('crane-station', 100, 100);
      hardware.syncLayout([crane]);
      hardware.syncLive([crane], new Set([crane.id]));
      expect(hardware.getSimulation().getGate(`CRANE-${crane.id}`)).toBeDefined();
    } finally {
      hardware.dispose();
    }
  });

  it('a live turntable carries a SWITCH- motor that confirms three distinct positions', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const t = piece('turntable', 100, 100);
      hardware.syncLayout([t]);
      hardware.syncLive([t], new Set([t.id]));

      const sw = hardware.getSimulation().getSwitch(`SWITCH-${t.id}`);
      expect(sw).toBeDefined();
      if (sw === undefined) throw new Error('unreachable');
      expect(sw.getPosition()).toBeUndefined();

      // A hand-spun deck seats and confirms exactly like a commanded one.
      sw.setPosition('stub-b');
      expect(sw.getPosition()).toBe('stub-b');
      const topic = `railway/events/switch_state_changed/SWITCH-${t.id}`;
      const published = client.published.filter((m) => m.topic === topic);
      expect(published).toHaveLength(1);
    } finally {
      hardware.dispose();
    }
  });

  it('a vision station asserts a passing train’s length from ITS OWN identity (ADR-023)', () => {
    /* The 001 proof, end-to-end: a train towing two wagons explores across the
     * station's marker; the station (not the train) emits train_length_changed
     * with the measured nose-to-tail length, and hysteresis keeps it from
     * re-reporting an unchanged estimate. */
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const s1 = piece('straight', 100, 100);
      const vs = piece('vision-station', 310, 100); // endpoints meet at x=200
      const train = piece('train', 110, 100);
      const red1 = carriage(60, 100, 'red');
      const red2 = carriage(10, 100, 'red');
      const pieces = [s1, vs, train, red1, red2];
      const live = new Set(pieces.map((p) => p.id));
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, live);

      // Drive the train across the station marker (exploration needs no server).
      hardware.getSimulation().handleCommand(`T-${train.id}`, 'begin_exploration', {});
      for (let i = 0; i < 150; i++) hardware.tick(200);

      const topic = `railway/events/train_length_changed/VLS-${vs.id}`;
      const reports = client.published.filter((m) => m.topic === topic);
      expect(reports).toHaveLength(1);
      const envelope = decodeEnvelope(reports[0] ?? { payload: new Uint8Array() });
      expect(envelope.device_id).toBe(`VLS-${vs.id}`);
      expect(envelope.payload.train_id).toBe(`T-${train.id}`);
      // 60 mm loco + 2 × 50 mm carriage spacing — measured, not configured.
      expect(envelope.payload.train_length_mm).toBe(160);
    } finally {
      hardware.dispose();
    }
  });

  it('a vision station stays silent for trains that never cross its marker', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const vs = piece('vision-station', 310, 100);
      hardware.syncLayout([vs]);
      hardware.syncLive([vs], new Set([vs.id]));
      for (let i = 0; i < 20; i++) hardware.tick(200);
      const topic = `railway/events/train_length_changed/VLS-${vs.id}`;
      expect(client.published.filter((m) => m.topic === topic)).toHaveLength(0);
    } finally {
      hardware.dispose();
    }
  });
});
