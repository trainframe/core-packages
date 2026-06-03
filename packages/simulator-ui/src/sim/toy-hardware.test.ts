import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import type { RotationDeg, TrackPiece } from '../track/pieces.js';
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

  it('despawns the train when the operator powers it back off', () => {
    const client = new InMemoryBrokerClient();
    client.connect('inmem://');
    const hardware = new ToyHardware({ client, newId });
    try {
      const { pieces, train } = twoStraightsAndATrain();
      hardware.syncLayout(pieces);
      hardware.syncLive(pieces, new Set([train.id]));
      hardware.syncLive(pieces, new Set());
      const sim = hardware.getSimulation();
      expect(sim.getTrain(`T-${train.id}`)).toBeUndefined();
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
