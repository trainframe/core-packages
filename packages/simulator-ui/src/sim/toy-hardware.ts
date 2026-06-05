import type { Layout } from '@trainframe/protocol';
import { BrokerBridge, Simulation } from '@trainframe/simulator';
import type { BrokerClient } from '../broker/client.js';
import { compileLayout } from '../track/layout-from-pieces.js';
import { type TrackPiece, isDevicePiece } from '../track/pieces.js';
import { nearestStartEdge } from './nearest-edge.js';

/** Device id for a piece's own broker identity. Must match `ToyTable`. */
function deviceIdForDevicePiece(piece: TrackPiece): string {
  if (piece.type === 'train') return `T-${piece.id}`;
  if (piece.type === 'gate') return `GATE-${piece.id}`;
  throw new Error(`deviceIdForDevicePiece called on non-device piece ${piece.type}`);
}

/**
 * Stable topology signature for a non-device piece. Used to detect when the
 * track layout actually changes, so dragging a train piece around (which only
 * affects device placement) doesn't tear down and rebuild the simulation.
 */
function pieceTopologyKey(p: TrackPiece): string {
  const flip = p.flipped === true ? 'F' : '';
  return `${p.id}|${p.type}|${Math.round(p.position.x)}|${Math.round(p.position.y)}|${p.rotationDeg}|${flip}`;
}

function topologySignature(pieces: ReadonlyArray<TrackPiece>): string {
  const keys: string[] = [];
  for (const p of pieces) {
    if (isDevicePiece(p.type)) continue;
    keys.push(pieceTopologyKey(p));
  }
  keys.sort();
  return keys.join('\n');
}

/**
 * Default UUID generator for `BrokerBridge`. Browsers have `crypto.randomUUID`;
 * fall back to a hex-ish token so jsdom/node test environments without it
 * still work. The wire envelope only needs uniqueness within a session.
 */
function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(performance.now() * 1000 + i * 7919).toString(36);
  return `id-${s}`;
}

export interface ToyHardwareOptions {
  readonly client: BrokerClient;
  /** Override UUID generator. Browser default is `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Cap on real elapsed ms forwarded to the sim per tick (default 200). */
  readonly maxTickMs?: number;
}

/**
 * Wires a physics-only `@trainframe/simulator` `Simulation` to the toy-table
 * UI. The simulation runs in-browser, exposes virtual devices to the wire via
 * `BrokerBridge`, and reacts to clearance commands from the real
 * `@trainframe/server`. No scheduling lives here.
 *
 * The class owns three pieces of state:
 *  - the current physics `Simulation` (rebuilt when the operator changes track
 *    topology — adding, removing, moving, or rotating a track piece);
 *  - the broker bridge that transports its events to MQTT;
 *  - the set of device-piece ids the operator has scanned live, so spawn /
 *    despawn calls only fire on actual transitions.
 *
 * The contract with `ToyTable.tsx`:
 *  - `syncLayout(pieces)` is called on every render; it short-circuits when
 *    the non-device topology hasn't changed.
 *  - `syncLive(pieces, liveIds)` is called on every render with the latest
 *    placed pieces and the operator's live set; spawn / despawn happen here.
 *  - `tick(realElapsedMs)` is called from a `requestAnimationFrame` loop in
 *    the hook.
 *
 * Side effect to be aware of: when the track topology changes the simulation
 * is torn down and rebuilt. Any train currently moving is re-spawned at its
 * start edge — the on-canvas piece doesn't remember the sim's true position.
 * Acceptable for v1; the operator typically builds the loop before scanning.
 */
export class ToyHardware {
  private readonly client: BrokerClient;
  private readonly newId: () => string;
  private readonly maxTickMs: number;

  private simulation: Simulation;
  private bridge: BrokerBridge;
  private layout: Layout;
  private topology: string;
  private lastLive: ReadonlySet<string> = new Set();

  constructor(options: ToyHardwareOptions) {
    this.client = options.client;
    this.newId = options.newId ?? defaultNewId;
    this.maxTickMs = options.maxTickMs ?? 200;
    // Start with an empty layout so the simulation is always alive; the first
    // `syncLayout` rebuilds it with the operator's pieces.
    const emptyLayout: Layout = { name: 'toy-table', markers: [], edges: [], junctions: [] };
    this.layout = emptyLayout;
    this.simulation = this.createSimulation(emptyLayout);
    this.bridge = this.createBridge(this.simulation);
    this.bridge.start();
    this.topology = '';
  }

  /**
   * Rebuild the simulation when the operator's track topology changes. No-op
   * otherwise. After a rebuild `lastLive` is reset to empty so the next
   * `syncLive` re-spawns the devices the operator still has scanned.
   *
   * Critically: this method does NOT publish anything through the bridge.
   * Placing an unscanned piece on the table must stay inert on the bus —
   * commissioning happens through the scan-box, not by mere placement.
   */
  syncLayout(pieces: ReadonlyArray<TrackPiece>): void {
    const next = topologySignature(pieces);
    if (next === this.topology) return;
    this.topology = next;
    this.bridge.stop();
    const layout = compileLayout(pieces, 'toy-table');
    this.layout = layout;
    this.simulation = this.createSimulation(layout);
    this.bridge = this.createBridge(this.simulation);
    this.bridge.start();
    this.lastLive = new Set();
  }

  /**
   * Reconcile the operator's live-piece set with the simulation. Newly-live
   * train pieces are spawned at the nearest outgoing edge; newly-dead pieces
   * are despawned. A train scanned before any edge originates near it is
   * deferred — it lives on the broker (its `device_registered` is already
   * out) but the simulation won't drive it until track exists.
   */
  syncLive(pieces: ReadonlyArray<TrackPiece>, liveIds: ReadonlySet<string>): void {
    const piecesById = new Map<string, TrackPiece>();
    for (const p of pieces) piecesById.set(p.id, p);

    for (const pieceId of liveIds) {
      if (this.lastLive.has(pieceId)) continue;
      const piece = piecesById.get(pieceId);
      if (piece !== undefined) this.spawnPiece(piece);
    }
    for (const pieceId of this.lastLive) {
      if (liveIds.has(pieceId)) continue;
      const piece = piecesById.get(pieceId);
      if (piece !== undefined) this.despawnPiece(piece);
    }

    this.lastLive = new Set(liveIds);
  }

  private spawnPiece(piece: TrackPiece): void {
    if (piece.type === 'train') {
      const startEdge = nearestStartEdge(this.layout, piece.position);
      if (startEdge === undefined) return; // defer until track exists
      this.simulation.spawnTrain(deviceIdForDevicePiece(piece), { startEdge });
      return;
    }
    if (piece.type === 'gate') {
      this.simulation.spawnGate(deviceIdForDevicePiece(piece));
      return;
    }
    if (piece.type === 'carriage') {
      // Carriages are wire-invisible physical wagons. The simulation has no
      // virtual carriage device — coupling detection lives in the UI layer
      // (`computeTrainTrails` in coupling.ts). Nothing to do here.
      return;
    }
    // Track pieces: ToyTable.scanPiece already published the tag_assignment
    // for `M-{piece.id}` via the GARAGE device. Mirror the binding into the
    // in-browser Simulation's markerToTag map silently so virtual trains
    // emit `tag_observed` when they cross this marker.
    const markerId = `M-${piece.id}`;
    this.simulation.bindIdentityTag(markerId);

    // Junction pieces need a virtual switch motor. The motor is registered
    // under `SWITCH-{piece.id}` with `controls_marker_id: markerId` so the
    // server can build the marker → device pairing. LearnMode then addresses
    // `set_switch_position` commands to the device id (looked up via
    // LayoutState.switchDeviceForMarker), not directly to the marker id.
    if (piece.type === 'junction') {
      this.simulation.spawnSwitch(`SWITCH-${piece.id}`, markerId);
    }
  }

  private despawnPiece(piece: TrackPiece): void {
    if (piece.type === 'train') {
      this.simulation.despawnTrain(deviceIdForDevicePiece(piece));
      return;
    }
    if (piece.type === 'gate') {
      this.simulation.despawnGate(deviceIdForDevicePiece(piece));
      return;
    }
    if (piece.type === 'carriage') {
      // Carriages have no simulation counterpart. Nothing to despawn.
      return;
    }
    if (piece.type === 'junction') {
      this.simulation.despawnSwitch(`SWITCH-${piece.id}`);
    }
  }

  /**
   * Advance the simulation by `realElapsedMs`, capped at `maxTickMs` so a
   * backgrounded tab doesn't fast-forward by minutes on resume.
   */
  tick(realElapsedMs: number): void {
    if (realElapsedMs <= 0) return;
    const capped = Math.min(realElapsedMs, this.maxTickMs);
    this.simulation.advance(capped);
  }

  /** Stop the bridge and detach. Idempotent. */
  dispose(): void {
    this.bridge.stop();
  }

  /** Test observer — never reach into private fields from outside. */
  getSimulation(): Simulation {
    return this.simulation;
  }

  private createSimulation(layout: Layout): Simulation {
    return new Simulation({ layout });
  }

  private createBridge(simulation: Simulation): BrokerBridge {
    return new BrokerBridge(simulation, this.client, { newId: this.newId });
  }
}
