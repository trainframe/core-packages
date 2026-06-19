/**
 * The toy-table HARDWARE ADAPTER, ported onto the ADR-030 physics engine.
 *
 * This is the keystone of the toy-table → physics migration: the in-browser toy
 * table now runs on a real `PhysicsWorld` driven by real physics DEVICES
 * (`ScheduledTrainDevice`, `GateDevice`, `SwitchDevice`, `YardZoneDevice`) — the
 * SAME devices the headless demos and the integration suite drive — instead of the
 * deleted-soon virtual-device sim (`Simulation` / `VirtualTrain` / `VirtualGate` /
 * `VirtualRailyard` / `VirtualSwitch`). Application code cannot tell the in-browser
 * toy table from physical hardware: each device speaks the protocol over its OWN
 * `mqttPlatform` (there is no single `BrokerBridge` any more) and reacts to clearance
 * from the real `@trainframe/server`. No scheduling lives here.
 *
 * ── What this layer owns ─────────────────────────────────────────────────────
 *  - the current `PhysicsWorld` (rebuilt when the operator changes the track
 *    topology — adding, removing, moving, or rotating a track piece) plus the
 *    logical `Layout` the devices dead-reckon against;
 *  - one physics DEVICE per live device-piece, each with its own platform;
 *  - the set of device-piece ids the operator has scanned live; the subset
 *    currently powered OFF in place; and the authoritative mechanical state of the
 *    command-driven switch / gate devices (their position / withholds), so it can be
 *    snapshotted across a topology rebuild and re-asserted on the bus.
 *
 * ── Three distinct lifecycle operations, kept separate (UNCHANGED contract) ──
 *  1. SCAN / UNSCAN (live set) — a piece entering the live set is spawned and
 *     announced; leaving it is a genuine despawn publishing `device_disconnected`.
 *  2. POWER off / on (powered subset) — toggles a live train between driven and
 *     inert-in-place (`device.power(on)`). It stays in the world and on the bus; it
 *     is NOT despawned and emits NO `device_disconnected`. Handled in `syncPower`.
 *  3. MOVE (drag) — relocation in the UI piece coordinates; it never routes through
 *     power or live reconciliation here.
 *
 * ── The device mapping (per live device-piece) ───────────────────────────────
 *  - TRAIN  → a loco body (+ its proximity-coupled carriage rake) in the world + a
 *    `ScheduledTrainDevice`. Power-off → `device.power(false)` (inert in place).
 *  - GATE / crane-station / lift-bridge → a `GateDevice` (a crane pins a dwelling
 *    train; a raised lift-bridge span withholds its own marker).
 *  - JUNCTION → a `SwitchDevice` throwing the compiled junction switch
 *    (`physicsSwitchActuator(world, 'M-{pieceId}')`).
 *  - RAILYARD → a `YardZoneDevice` whose slots are DISCOVERED under the gantry's
 *    footprint (`buildDiscoveredYard`) and driven IN PLACE in the one compiled net;
 *    finding no fan fronting two leads, the gantry STALLS.
 *
 * ── World construction ───────────────────────────────────────────────────────
 * The `PhysicsWorld` runs ONE rail network: `compileNetwork(pieces).net` — the operator's
 * whole table. A running loop and a managed yard COEXIST because they are the SAME net:
 * the gantry's discovered slot segments and the loop's running segments are all in it. A
 * live railyard gantry manages the operator's REAL slots in place (`discoveredYardLayout`
 * projects them into a `YardController`-ready view; the west/east points are LADDER
 * actuators over the operator's own junctions). There is NO synthetic yard net and NO
 * translation — the railyard-in-toybox keystone, loop + yard in one world.
 *
 * Pure-ish: the only impurity is the injected `newId` (browser `crypto.randomUUID`,
 * a deterministic stub in tests) and the real elapsed ms the RAF loop hands `tick`.
 */
import { type CoreEvent, type Layout, PROTOCOL_VERSION, topics } from '@trainframe/protocol';
import type { BrokerClient } from '@trainframe/simulator/broker/client.js';
import { mqttPlatform } from '@trainframe/simulator/broker/mqtt-platform.js';
import { GateDevice } from '@trainframe/simulator/devices/gate-device.js';
import type { PlatformProvider } from '@trainframe/simulator/devices/platform-provider.js';
import {
  ScheduledTrainDevice,
  type TrainDriveState,
} from '@trainframe/simulator/devices/scheduled-train-device.js';
import { SwitchDevice } from '@trainframe/simulator/devices/switch-device.js';
import { YardZoneDevice } from '@trainframe/simulator/devices/yard-zone-device.js';
import {
  type CompiledNetwork,
  compileNetwork,
} from '@trainframe/simulator/physics/network-from-pieces.js';
import type { BodyPose } from '@trainframe/simulator/physics/observation.js';
import { PhysicsWorld } from '@trainframe/simulator/physics/world.js';
import type { YardLayout } from '@trainframe/simulator/physics/yard.js';
import { discoveredYardActuator } from '@trainframe/simulator/sim/discovered-yard-actuator.js';
import { physicsMarkerSensor } from '@trainframe/simulator/sim/marker-sensor.js';
import { physicsMotorActuator } from '@trainframe/simulator/sim/motor-actuator.js';
import { physicsSwitchActuator } from '@trainframe/simulator/sim/switch-actuator.js';
import { computeTrainTrails } from '@trainframe/simulator/track/coupling.js';
import { compileLayout } from '@trainframe/simulator/track/layout-from-pieces.js';
import {
  TRAIN_LENGTH_MM,
  TURNTABLE_POSITIONS,
  type TrackPiece,
  isDevicePiece,
  layerOf,
} from '@trainframe/simulator/track/pieces.js';
import { ToyVisionStations, type TrainBody, type VisionBody } from './toy-vision.js';
import { type DiscoveredYard, buildDiscoveredYard, yardFootprintOf } from './toy-yard.js';

/** The toy-table railyard's service capacity — visitors it admits (queued, one
 *  serviced at a time). Plenty for a handful of trains + spares. */
const RAILYARD_CAPACITY = 4;

/** Crane camera footprint radius (mm) — the yard device's own sensor reach, mirrored
 *  from the headless demos so the discovered yard reads its bodies the same way. */
const YARD_CAMERA_RADIUS = 20;

/** A STOPPED loco's max speed (mm/s) for the throat camera: a train merely passing the
 *  throat (still moving) is never grabbed as a parked visitor. */
const PARKED_SPEED_EPS = 6;

/** Per-carriage spacing (mm) along the rail when seeding a train's rake — matches the
 *  physics CameraProvider's car spacing so a measured length reads sensibly. */
const CARRIAGE_SPACING_MM = 68;

/** Half-extents (mm) of the bodies a vision camera perceives along the rail. */
const HALF_LEN = { loco: 34, carriage: 30 } as const;

/** Hysteresis band (mm) for a vision station's length reports: a fresh estimate within
 *  this of the last reported value is unchanged, so a noisy measurement doesn't emit a
 *  stream of `train_length_changed`. */
const VISION_HYSTERESIS_MM = 30;

/** Sub-step (ms) the world is advanced in while a vision station is live, so the fixed
 *  camera samples a passing train at a sensible frame rate (~50 ms). */
const VISION_SAMPLE_MS = 50;

/** Physics tick (s): one 60 Hz frame, matching the demos' deterministic pump. */
const DT = 1 / 60;

/** Device id for a piece's own broker identity. Must match `ToyTable`. */
function deviceIdForDevicePiece(piece: TrackPiece): string {
  if (piece.type === 'train') return `T-${piece.id}`;
  if (piece.type === 'gate') return `GATE-${piece.id}`;
  if (piece.type === 'railyard') return `YARD-${piece.id}`;
  throw new Error(`deviceIdForDevicePiece called on non-device piece ${piece.type}`);
}

/** The physics switch device id a junction piece owns. */
function switchDeviceIdFor(piece: TrackPiece): string {
  return `SWITCH-${piece.id}`;
}

/** Mechanical device state snapshotted across a world rebuild: a switch's confirmed
 *  position, or a gate's withheld markers. */
type DeviceState =
  | { readonly kind: 'switch'; readonly position: string }
  | { readonly kind: 'gate'; readonly withheld: ReadonlyArray<string> };

/** Stable topology signature for a non-device piece, so dragging a train piece around
 *  (which only affects device placement) doesn't tear down and rebuild the world. Layer
 *  is part of the signature: two layouts identical in 2D but differing in layer are a
 *  bridge vs a crossing — genuinely different topology. */
function pieceTopologyKey(p: TrackPiece): string {
  const flip = p.flipped === true ? 'F' : '';
  return `${p.id}|${p.type}|${Math.round(p.position.x)}|${Math.round(p.position.y)}|${p.rotationDeg}|${flip}|L${layerOf(p)}`;
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

/** Default UUID generator for the device platforms. Browsers have `crypto.randomUUID`;
 *  fall back to a hex-ish token so jsdom/node test environments without it work. */
function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(performance.now() * 1000 + i * 7919).toString(36);
  return `id-${s}`;
}

/** Hex livery for a carriage colour id — the body colour a camera reads. */
function liveryHex(colorId: string): string {
  switch (colorId) {
    case 'red':
      return '#c0392b';
    case 'green':
      return '#27ae60';
    case 'amber':
      return '#e08a1e';
    case 'purple':
      return '#7d3cab';
    default:
      return '#2e6fb7';
  }
}

export interface ToyHardwareOptions {
  readonly client: BrokerClient;
  /** Override UUID generator. Browser default is `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Cap on real elapsed ms forwarded to the world per tick (default 200). */
  readonly maxTickMs?: number;
}

/** One live train: its scheduler device, its loco body id (== the device id), and the
 *  ids of the carriage bodies coupled behind it (its seeded rake). */
interface LiveTrain {
  readonly device: ScheduledTrainDevice;
  readonly bodyId: string;
  readonly carriageBodyIds: readonly string[];
}

/** One live railyard gantry: the zone device + the discovered yard it works (or null
 *  when no fan of slots was found — the gantry stalls). */
interface LiveYard {
  readonly device: YardZoneDevice;
  readonly discovered: DiscoveredYard | null;
}

export class ToyHardware {
  private readonly client: BrokerClient;
  private readonly newId: () => string;
  private readonly maxTickMs: number;

  private world: PhysicsWorld;
  private compiled: CompiledNetwork;
  private layout: Layout;
  private topology: string;
  /** The drivable yard the world's network is currently built from, if a gantry
   *  discovered one (else null → the world is `compiled.net`). */
  private activeYard: DiscoveredYard | null = null;

  private readonly trains = new Map<string, LiveTrain>();
  private readonly gates = new Map<string, GateDevice>();
  private readonly switches = new Map<string, SwitchDevice>();
  private readonly yards = new Map<string, LiveYard>();

  /** Authoritative mechanical state ToyHardware commands + tracks (the devices are
   *  command-driven and expose no getter): switch device id → position. */
  private readonly switchPositions = new Map<string, string>();
  /** Gate device id → its currently-withheld markers. */
  private readonly gateWithholds = new Map<string, Set<string>>();

  private lastLive: ReadonlySet<string> = new Set();
  private lastPieces: ReadonlyMap<string, TrackPiece> = new Map();
  private lastPoweredOff: ReadonlySet<string> = new Set();

  /** The honest vision length stations (experimental 001, ADR-030 §5). */
  private readonly vision = new ToyVisionStations((stationDeviceId, trainId, lengthMm) =>
    this.onVisionLength(stationDeviceId, trainId, lengthMm),
  );
  private readonly visionReported = new Map<string, number>();

  /** Mechanical device state captured just before a rebuild, re-asserted on respawn. */
  private pendingDeviceState = new Map<string, DeviceState>();

  /** Running trains' pose + driving state captured just before a rebuild, restored
   *  on respawn so editing track elsewhere doesn't stop or rewind a moving train. */
  private pendingTrainState = new Map<string, { pose: BodyPose; drive: TrainDriveState }>();

  /** Carriage PIECE ids a live train's rake claimed this build — the rest, parked over
   *  a gantry, become its spares. Recomputed each `rebuildDevices`. */
  private claimedCarriagePieceIds = new Set<string>();

  constructor(options: ToyHardwareOptions) {
    this.client = options.client;
    this.newId = options.newId ?? defaultNewId;
    this.maxTickMs = options.maxTickMs ?? 200;
    this.layout = { name: 'toy-table', markers: [], edges: [], junctions: [] };
    this.compiled = compileNetwork([]);
    this.world = new PhysicsWorld(this.compiled.net);
    this.topology = '';
  }

  // ---- public surface (the React hook's contract) -----------------------

  /**
   * Rebuild the world when the operator's track topology changes. No-op otherwise.
   * Mechanical device state (switch positions, gate withholds) is snapshotted before
   * teardown and re-asserted through the respawned devices. Publishes nothing on mere
   * placement — commissioning happens through the scan-box.
   */
  syncLayout(pieces: ReadonlyArray<TrackPiece>): void {
    const next = topologySignature(pieces);
    if (next === this.topology) return;
    this.rebuild(pieces, next);
  }

  /**
   * Reconcile the operator's live-piece set with the world. Newly-live device pieces
   * are spawned and announced; newly-dead pieces are despawned (publishing
   * `device_disconnected`). A train scanned before any rail originates near it is
   * deferred — it lives on the broker but no body is driven until track exists.
   *
   * Spawning / despawning a body-bearing piece (train / carriage / railyard) changes
   * the world's body population (and a railyard may change the world's NETWORK), so it
   * triggers a world rebuild that re-seeds every still-live device — the toy-table's
   * analogue of a real device joining or leaving the bus.
   */
  syncLive(pieces: ReadonlyArray<TrackPiece>, liveIds: ReadonlySet<string>): void {
    const piecesById = new Map<string, TrackPiece>();
    for (const p of pieces) piecesById.set(p.id, p);

    /* Departures first: a leaving piece publishes its disconnect (resolved against the
     *  previous snapshot if it was deleted in the same render). */
    for (const pieceId of this.lastLive) {
      if (liveIds.has(pieceId)) continue;
      const piece = piecesById.get(pieceId) ?? this.lastPieces.get(pieceId);
      if (piece !== undefined) this.announceDepart(piece);
    }

    /* Rebuild the world + devices from the new live set, then announce arrivals' state
     *  that the rebuild itself didn't (already handled in spawn). */
    this.lastLive = new Set(liveIds);
    this.lastPieces = piecesById;
    this.rebuildDevices(pieces, liveIds);
    this.vision.index(pieces, liveIds);
  }

  /**
   * Reconcile which live trains are powered OFF in place. A train newly off is set
   * inert (frozen, silent — no `device_disconnected`); one newly absent is powered back
   * on and resumes. Only affects already-spawned trains. Never spawns, despawns, or
   * publishes anything.
   */
  syncPower(_pieces: ReadonlyArray<TrackPiece>, poweredOffIds: ReadonlySet<string>): void {
    const apply = (pieceId: string, powered: boolean): void => {
      this.trains.get(`T-${pieceId}`)?.device.power(powered);
    };
    for (const pieceId of poweredOffIds) {
      if (!this.lastPoweredOff.has(pieceId)) apply(pieceId, false);
    }
    for (const pieceId of this.lastPoweredOff) {
      if (!poweredOffIds.has(pieceId)) apply(pieceId, true);
    }
    this.lastPoweredOff = new Set(poweredOffIds);
  }

  /**
   * Advance the world + every device by `realElapsedMs`, capped at `maxTickMs` so a
   * backgrounded tab can't fast-forward minutes on resume. The world steps in fixed
   * `DT` frames (the demos' deterministic pump); each yard + train device steps with
   * it. Devices publish their own events; the server reacts with clearance.
   *
   * While a vision station is live, the cap is consumed in sub-steps no coarser than
   * the camera frame interval, so a long animation-frame gap doesn't skip a train past
   * the sensing markers and footprint in one jump.
   */
  tick(realElapsedMs: number): void {
    if (realElapsedMs <= 0) return;
    const capped = Math.min(realElapsedMs, this.maxTickMs);
    if (this.vision.hasLiveStation()) {
      let remaining = capped;
      while (remaining > 0) {
        const step = Math.min(remaining, VISION_SAMPLE_MS);
        this.advance(step);
        this.vision.tick(step, this.collectTrainBodies());
        remaining -= step;
      }
      return;
    }
    this.advance(capped);
  }

  /**
   * Every body's pose in the world — the toy-table analogue the renderer draws from
   * (REPLACES the old `getSimulation()` accessor). The same shape the headless world
   * exposes via `world.bodies()`; the React layer reads poses, never computes them.
   */
  bodies(): readonly BodyPose[] {
    return this.world.bodies();
  }

  /** Throw a live junction's points (operator intent / a test). Drives the real
   *  `SwitchDevice` over the bus and tracks the position for snapshot/restore. */
  setSwitch(pieceId: string, position: string): void {
    const deviceId = `SWITCH-${pieceId}`;
    if (!this.switches.has(deviceId)) return;
    this.commandSwitch(deviceId, `M-${pieceId}`, position);
  }

  /** The confirmed position of a live junction's switch, or undefined. */
  switchPosition(pieceId: string): string | undefined {
    return this.switchPositions.get(`SWITCH-${pieceId}`);
  }

  /** Withhold clearance across a gate's marker (operator intent / a test). */
  holdGate(deviceId: string, markerId: string, reason = 'gate'): void {
    const gate = this.gates.get(deviceId);
    if (gate === undefined) return;
    gate.hold(markerId, reason);
    const set = this.gateWithholds.get(deviceId) ?? new Set();
    set.add(markerId);
    this.gateWithholds.set(deviceId, set);
  }

  /** Release a held gate marker. */
  releaseGate(deviceId: string, markerId: string): void {
    this.gates.get(deviceId)?.release(markerId);
    this.gateWithholds.get(deviceId)?.delete(markerId);
  }

  /** Whether a gate device is withholding a marker. */
  isWithholding(deviceId: string, markerId: string): boolean {
    return this.gateWithholds.get(deviceId)?.has(markerId) ?? false;
  }

  /** A live railyard gantry's asserted occupancy (the zone fact core sees), or 0. */
  yardOccupancy(pieceId: string): number {
    return this.yards.get(`YARD-${pieceId}`)?.device.occupancy ?? 0;
  }

  /** Stop every live device and detach. Idempotent. */
  dispose(): void {
    this.teardownAllDevices();
  }

  // ---- world + device (re)build -----------------------------------------

  /** Rebuild the whole world for a new topology: snapshot mechanical device state,
   *  tear every device down, recompile the network + layout, then re-spawn whatever the
   *  operator still has scanned on the fresh world. */
  private rebuild(pieces: ReadonlyArray<TrackPiece>, topology: string): void {
    this.topology = topology;
    this.pendingDeviceState = this.snapshotDeviceState();
    /* Capture running trains BEFORE teardown (the old world + devices are still
     *  live here) so each is restored at its current pose, still driving. */
    this.pendingTrainState = this.snapshotTrainState();
    const stillLive = this.lastLive;
    const piecesById = new Map<string, TrackPiece>();
    for (const p of pieces) piecesById.set(p.id, p);
    const live = new Set([...stillLive].filter((id) => piecesById.has(id)));
    this.lastPoweredOff = new Set();
    this.vision.reset();
    this.visionReported.clear();
    this.rebuildDevices(pieces, live);
    this.lastLive = new Set(live);
    this.lastPieces = piecesById;
    this.vision.index(pieces, live);
  }

  /** Tear every device down, compile the ONE unified network (the operator's whole
   *  table — a running loop AND any discovered yard slots are BOTH in it), and respawn
   *  every live device on it. The gantry manages the operator's real slots in place; the
   *  world is ALWAYS `compileNetwork(pieces).net` (no synthetic yard, no translation). */
  private rebuildDevices(pieces: ReadonlyArray<TrackPiece>, liveIds: ReadonlySet<string>): void {
    this.teardownAllDevices();
    this.claimedCarriagePieceIds = new Set();
    this.compiled = compileNetwork(pieces);
    this.activeYard = this.discoverActiveYard(pieces, liveIds);
    /* Compile the scheduler's logical layout. With a discovered yard, its throat marker
     *  (`M-{railyardId}`, at the piece centre) is repositioned to the world throat point so
     *  the scheduler can route a train to STOP there for a service — the marker sensor
     *  fires where the loco physically parks. */
    this.layout = this.compileLayoutForWorld(pieces);
    this.world = new PhysicsWorld(this.compiled.net);
    /* Spawn order: switches + gates first (no bodies), then the yard (it may seed
     *  spares + the interior switch state), then trains (their bodies seed last so the
     *  yard's slots/leads exist for a visitor). */
    for (const p of pieces) {
      if (liveIds.has(p.id) && (p.type === 'junction' || p.type === 'turntable' || isGatePiece(p)))
        this.spawnPiece(p, pieces);
    }
    for (const p of pieces)
      if (liveIds.has(p.id) && p.type === 'railyard') this.spawnPiece(p, pieces);
    for (const p of pieces) if (liveIds.has(p.id) && p.type === 'train') this.spawnPiece(p, pieces);
    this.seedYardSpares(pieces, liveIds);
  }

  /** Seed the gantry's stabled SPARES: carriage pieces the operator parked OVER the
   *  discovered yard that no train claimed (ADR-016) become free, coupled bodies in a
   *  yard slot — the cut a visitor's service migrates onto. The gantry then DISCOVERS
   *  them by camera (`searchForStock`); none parked → it stalls (no swap), faithfully.
   *  Spares are only meaningful when a gantry's interior is the active world. */
  private seedYardSpares(pieces: ReadonlyArray<TrackPiece>, liveIds: ReadonlySet<string>): void {
    if (this.activeYard === null) return;
    const claimed = new Set<string>();
    for (const live of this.trains.values()) for (const id of live.carriageBodyIds) claimed.add(id);
    const sparesSlot = this.activeYard.layout.slots[1] ?? this.activeYard.layout.slots[0];
    const slotGeom =
      sparesSlot === undefined ? undefined : this.activeYard.layout.geom.get(sparesSlot);
    if (sparesSlot === undefined || slotGeom === undefined) return;
    /* Park the cut near the slot's FOOT (the far end an arrival rests at), coupled and
     *  spaced one car apart, where the controller reverses onto them. A discovered slot
     *  ROAD spans several real segments, so the cut is seeded by WORLD POINT along the
     *  slot's geom (`placeBodyAt` finds the right segment + distance) — never by a railPos
     *  on the slot's representative segment, which is only one piece of the road. */
    const slotLen = Math.hypot(slotGeom.ax - slotGeom.bx, slotGeom.ay - slotGeom.by) || 1;
    /* Unit vector along the slot from its FOOT (`b`) toward its MOUTH (`a`). */
    const ux = (slotGeom.ax - slotGeom.bx) / slotLen;
    const uy = (slotGeom.ay - slotGeom.by) / slotLen;
    const spareParts = pieces.filter(
      (p) =>
        p.type === 'carriage' &&
        liveIds.has(p.id) &&
        !this.claimedCarriagePieceIds.has(p.id) &&
        this.nearActiveYard(p.position),
    );
    let prev: string | undefined;
    for (let i = 0; i < spareParts.length; i++) {
      const cp = spareParts[i];
      if (cp === undefined) continue;
      const along = Math.max(2, slotLen * 0.55 - i * CARRIAGE_SPACING_MM);
      const bodyId = this.seedSpare(cp, slotGeom.bx + ux * along, slotGeom.by + uy * along);
      if (prev !== undefined) this.world.couple(prev, bodyId);
      prev = bodyId;
    }
  }

  /** Place one spare carriage body on the rail nearest world `(x, y)` and return its id. */
  private seedSpare(cp: TrackPiece, x: number, y: number): string {
    const bodyId = `SPARE-${cp.id}`;
    this.world.placeBodyAt(
      {
        id: bodyId,
        kind: 'carriage',
        facing: 1,
        ...(cp.colorId !== undefined ? { color: liveryHex(cp.colorId) } : {}),
      },
      x,
      y,
    );
    return bodyId;
  }

  /** Whether a world point lies within the active yard's bounding box (+margin). */
  private nearActiveYard(pos: { x: number; y: number }): boolean {
    if (this.activeYard === null) return false;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const g of this.activeYard.layout.geom.values()) {
      minX = Math.min(minX, g.ax, g.bx);
      maxX = Math.max(maxX, g.ax, g.bx);
      minY = Math.min(minY, g.ay, g.by);
      maxY = Math.max(maxY, g.ay, g.by);
    }
    const m = 200;
    return pos.x >= minX - m && pos.x <= maxX + m && pos.y >= minY - m && pos.y <= maxY + m;
  }

  /** The first live railyard gantry that discovers a fan of slots under its footprint —
   *  whose REAL slots (already in the one compiled net) it manages. None → null. */
  private discoverActiveYard(
    pieces: ReadonlyArray<TrackPiece>,
    liveIds: ReadonlySet<string>,
  ): DiscoveredYard | null {
    for (const p of pieces) {
      if (p.type !== 'railyard' || !liveIds.has(p.id)) continue;
      const found = buildDiscoveredYard(this.compiled, yardFootprintOf(p), pieces);
      if (found !== null) return found;
    }
    return null;
  }

  /** The scheduler's logical layout for the active world. With a gantry interior as the
   *  world, the railyard throat marker is moved to the world throat point (so a routed
   *  train stops there for a service) and a yard-far marker is added at the east lead. */
  private compileLayoutForWorld(pieces: ReadonlyArray<TrackPiece>): Layout {
    const base = compileLayout(pieces, 'toy-table');
    const yard = this.activeYard;
    if (yard === null) return base;
    const throatPiece = pieces.find((p) => p.type === 'railyard');
    if (throatPiece === undefined) return base;
    const throatId = `M-${throatPiece.id}`;
    const east = yard.layout.geom.get(yard.layout.leadEast);
    const markers = base.markers.map((m) =>
      m.id === throatId
        ? {
            ...m,
            kind: 'yard_entry' as const,
            position: { x_mm: yard.throatPoint.x, y_mm: yard.throatPoint.y },
          }
        : m,
    );
    if (east !== undefined && !markers.some((m) => m.id === `${throatId}-far`)) {
      markers.push({
        id: `${throatId}-far`,
        kind: 'block_boundary',
        position: { x_mm: east.bx, y_mm: east.by },
      });
      base.edges.push(
        { from_marker_id: throatId, to_marker_id: `${throatId}-far`, estimated_length_mm: 1000 },
        { from_marker_id: `${throatId}-far`, to_marker_id: throatId, estimated_length_mm: 1000 },
      );
    }
    return { ...base, markers };
  }

  // ---- spawn ------------------------------------------------------------

  private spawnPiece(piece: TrackPiece, pieces: ReadonlyArray<TrackPiece>): void {
    switch (piece.type) {
      case 'train':
        this.spawnTrain(piece, pieces);
        return;
      case 'gate':
        this.spawnGate(`GATE-${piece.id}`, piece);
        return;
      case 'railyard':
        this.spawnYard(piece);
        return;
      case 'junction':
        this.spawnSwitch(piece);
        return;
      case 'turntable':
        this.spawnSwitch(piece);
        return;
      case 'crane-station':
        this.spawnGate(`CRANE-${piece.id}`, piece);
        return;
      case 'lift-bridge':
        this.spawnGate(`BRIDGE-${piece.id}`, piece);
        return;
      default:
        return;
    }
  }

  /** Publish a departing device's `device_disconnected` (the rebuild then drops it). */
  private announceDepart(piece: TrackPiece): void {
    const ids: string[] = [];
    if (piece.type === 'train') ids.push(`T-${piece.id}`);
    else if (piece.type === 'gate') ids.push(`GATE-${piece.id}`);
    else if (piece.type === 'railyard') ids.push(`YARD-${piece.id}`);
    else if (piece.type === 'junction' || piece.type === 'turntable')
      ids.push(`SWITCH-${piece.id}`);
    else if (piece.type === 'crane-station') ids.push(`CRANE-${piece.id}`);
    else if (piece.type === 'lift-bridge') ids.push(`BRIDGE-${piece.id}`);
    for (const id of ids) this.platformFor(id).publish(this.disconnectEvent(id));
  }

  // ---- trains -----------------------------------------------------------

  /** Spawn a loco body (+ its proximity-coupled carriage rake) at the rail nearest the
   *  train piece, facing the way the piece points, and wire a `ScheduledTrainDevice`.
   *  Defers (registers but seeds no body) if no rail originates near the piece. */
  private spawnTrain(piece: TrackPiece, pieces: ReadonlyArray<TrackPiece>): void {
    const deviceId = deviceIdForDevicePiece(piece);
    /* A train captured running before this rebuild is re-seated at its CURRENT
     *  pose (still on the new net, by world position) rather than its piece's
     *  placement — and its driving state is restored below, so a track edit
     *  elsewhere neither stops nor rewinds it. */
    const pending = this.pendingTrainState.get(deviceId);
    this.pendingTrainState.delete(deviceId);
    const seatPos =
      pending !== undefined ? { x: pending.pose.x, y: pending.pose.y } : piece.position;
    const seatDeg = pending !== undefined ? pending.pose.rotationDeg : piece.rotationDeg;
    const rad = (seatDeg * Math.PI) / 180;
    const seat = this.seatNearest(seatPos, { x: Math.cos(rad), y: Math.sin(rad) });
    let carriageBodyIds: string[] = [];
    let lengthMm = TRAIN_LENGTH_MM;
    if (seat !== undefined) {
      this.world.addBody({
        id: deviceId,
        kind: 'loco',
        segment: seat.segment,
        railPos: seat.railPos,
        facing: seat.facing,
        // The loco's livery (toybox pick) drives its body colour; absent ⇒ the
        // iconic red. Keeps the moving body in step with its toy-table piece.
        color: piece.colorId !== undefined ? liveryHex(piece.colorId) : '#c0392b',
      });
      carriageBodyIds = this.seedRake(deviceId, piece, pieces, seat);
      lengthMm = TRAIN_LENGTH_MM + carriageBodyIds.length * CARRIAGE_SPACING_MM;
    }
    const device = new ScheduledTrainDevice(deviceId, {
      platform: this.platformFor(deviceId),
      motor: physicsMotorActuator(this.world, deviceId),
      sensor: physicsMarkerSensor(this.world, deviceId, this.markerPoints()),
      layout: this.layout,
      lengthMm,
      canReverse: true,
      newId: this.newId,
    });
    device.start();
    /* Resume a preserved train mid-run: route, clearance, and motion are
     *  re-asserted onto the now-seated body. Skipped when the body couldn't be
     *  re-seated (its track was removed under it) — then it stops, fairly. */
    if (pending !== undefined && seat !== undefined) device.restoreDrive(pending.drive);
    this.trains.set(deviceId, { device, bodyId: deviceId, carriageBodyIds });
  }

  /** Seed the carriage bodies coupled behind a loco, from the carriages near the train
   *  piece (`computeTrainTrails`), spaced one car back each. Returns the body ids in
   *  rake order (nearest the loco first). */
  private seedRake(
    locoBodyId: string,
    trainPiece: TrackPiece,
    pieces: ReadonlyArray<TrackPiece>,
    seat: { segment: string; railPos: number; facing: 1 | -1 },
  ): string[] {
    const liveIds = new Set([trainPiece.id]);
    const piecesById = new Map<string, TrackPiece>();
    for (const p of pieces) {
      piecesById.set(p.id, p);
      if (p.type === 'carriage') liveIds.add(p.id);
    }
    const carriagePieceIds = computeTrainTrails(pieces, liveIds).get(trainPiece.id) ?? [];
    const bodyIds: string[] = [];
    let prev = locoBodyId;
    for (let i = 0; i < carriagePieceIds.length; i++) {
      const cpId = carriagePieceIds[i] ?? '';
      this.claimedCarriagePieceIds.add(cpId);
      const cp = piecesById.get(cpId);
      const bodyId = `${locoBodyId}-c${i}`;
      this.world.addBody({
        id: bodyId,
        kind: 'carriage',
        segment: seat.segment,
        railPos: Math.max(2, seat.railPos - seat.facing * (i + 1) * CARRIAGE_SPACING_MM),
        facing: seat.facing,
        ...(cp?.colorId !== undefined ? { color: liveryHex(cp.colorId) } : {}),
      });
      this.world.couple(prev, bodyId);
      bodyIds.push(bodyId);
      prev = bodyId;
    }
    return bodyIds;
  }

  // ---- gates ------------------------------------------------------------

  /** Spawn a gate device over a marker. Re-asserts any snapshotted withholds so a
   *  raised span stays raised across a rebuild. */
  private spawnGate(deviceId: string, piece: TrackPiece): void {
    if (this.gates.has(deviceId)) return;
    const markerId = `M-${piece.id}`;
    const device = new GateDevice(deviceId, {
      platform: this.platformFor(deviceId),
      markers: [markerId],
      newId: this.newId,
    });
    device.start();
    this.gates.set(deviceId, device);
    this.gateWithholds.set(deviceId, new Set());
    this.restoreGate(deviceId, device);
  }

  // ---- switches ---------------------------------------------------------

  /** Spawn a switch device over a junction OR turntable piece, throwing the
   *  compiled switch. A junction is a two-way diverge ('main'/'divert'); a
   *  turntable is the N-way deck (`TURNTABLE_POSITIONS`) — deferred in the physics
   *  net (a non-routing gap), so its `world.setSwitch` is a harmless position
   *  store that the deck angle + `switch_state_changed` read off. Re-asserts any
   *  snapshotted position across a rebuild. */
  private spawnSwitch(piece: TrackPiece): void {
    const deviceId = switchDeviceIdFor(piece);
    if (this.switches.has(deviceId)) return;
    const junctionMarkerId = `M-${piece.id}`;
    const positions = piece.type === 'turntable' ? [...TURNTABLE_POSITIONS] : ['main', 'divert'];
    const actuator = physicsSwitchActuator(this.world, junctionMarkerId);
    const device = new SwitchDevice(deviceId, {
      platform: this.platformFor(deviceId),
      actuator,
      junctionMarkerId,
      positions,
      newId: this.newId,
    });
    device.start();
    this.switches.set(deviceId, device);
    /* Re-assert this junction's position onto the freshly-compiled world. Every
     *  rebuild makes a NEW `PhysicsWorld` whose switch map starts empty — unless the
     *  position is set, the net gates the junction's facing move CLOSED, so an
     *  exploring/scheduled train can never cross it and the track beyond is never
     *  discovered. The desired position is: a pre-rebuild snapshot if any (the
     *  `rebuild()` path), else the position carried across a `syncLive` rebuild
     *  (which doesn't snapshot), else the through-leg REST default — a turnout has a
     *  defined rest position. Set the world DIRECTLY via the actuator (synchronous,
     *  no bus round-trip on every rebuild); only when the position actually CHANGES
     *  do we go through `commandSwitch` to publish a `switch_state_changed`. */
    const snap = this.pendingDeviceState.get(deviceId);
    this.pendingDeviceState.delete(deviceId);
    const snapPosition = snap?.kind === 'switch' ? snap.position : undefined;
    const desired = snapPosition ?? this.switchPositions.get(deviceId) ?? positions[0];
    if (desired === undefined) return;
    if (desired === positions[0]) {
      /* The through-leg REST position: set the world SILENTLY (no bus chatter on
       *  every rebuild — a turnout at rest doesn't keep announcing itself). The
       *  direct actuator.set is what opens the facing move on the freshly-compiled
       *  world; without it the junction is gated closed and undiscoverable. */
      actuator.set(desired);
      this.switchPositions.set(deviceId, desired);
    } else {
      /* A THROWN (non-default) position re-asserts itself on the bus when the
       *  device respawns — like a held gate announcing where it stands after a
       *  rebuild — so observers see the live position. */
      this.commandSwitch(deviceId, junctionMarkerId, desired);
    }
  }

  // ---- railyard gantry --------------------------------------------------

  /** Spawn a railyard gantry: it manages the discovered yard (if its footprint found a
   *  fan), or stalls (announced + gating, but no slots to service). */
  private spawnYard(piece: TrackPiece): void {
    const deviceId = deviceIdForDevicePiece(piece);
    if (this.yards.has(deviceId)) return;
    const throatMarker = `M-${piece.id}`;
    const discovered = this.activeYard;

    const scene =
      discovered === null
        ? { yard: emptyYardLayout(this.compiled), throatMarker }
        : { yard: discovered.layout, throatMarker, throatPoint: discovered.throatPoint };

    const device = new YardZoneDevice(deviceId, {
      platform: this.platformFor(deviceId),
      scene,
      capacity: RAILYARD_CAPACITY,
      /* The west/east points are LADDER actuators over the operator's real junctions:
       *  `set(slotId)` throws the run of points that routes a lead into that slot (and the
       *  rest to their through leg). The controller, which thinks in a single
       *  diverge/converge switch, never knows a ladder of real turnouts is behind them. */
      westPoints:
        discovered === null
          ? noopActuator()
          : discoveredYardActuator(this.world, discovered.ladder, 'west'),
      eastPoints:
        discovered === null
          ? noopActuator()
          : discoveredYardActuator(this.world, discovered.ladder, 'east'),
      look: (x, y) => {
        const s = this.world.sampleAt(x, y, YARD_CAMERA_RADIUS);
        return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
      },
      wedgeAt: (x, y) => {
        this.world.uncoupleAt(x, y);
      },
      sightedTrainAt: (x, y, r) => this.nearestStoppedLoco(x, y, r),
      motorFor: (id) => physicsMotorActuator(this.world, id),
    });
    device.start();
    this.yards.set(deviceId, { device, discovered });
  }

  /** The id of the nearest STOPPED loco within `r` of (x,y) — the yard throat camera. */
  private nearestStoppedLoco(x: number, y: number, r: number): string | null {
    let best: { id: string; d2: number } | null = null;
    for (const b of this.world.bodies()) {
      if (b.kind !== 'loco' || b.speed > PARKED_SPEED_EPS) continue;
      const d2 = (b.x - x) ** 2 + (b.y - y) ** 2;
      if (best === null || d2 < best.d2) best = { id: b.id, d2 };
    }
    return best === null || best.d2 > r * r ? null : best.id;
  }

  // ---- device state snapshot / restore ----------------------------------

  /** Snapshot every live train's current body pose + driving state, so a rebuild
   *  (triggered by a track edit) restores it where it was, still running, rather
   *  than re-seeding it at its piece's placement and stopped. Reads the OLD world
   *  + devices, so it must run BEFORE teardown. A train with no body yet (deferred,
   *  never seeded) has nothing to preserve. */
  private snapshotTrainState(): Map<string, { pose: BodyPose; drive: TrainDriveState }> {
    const out = new Map<string, { pose: BodyPose; drive: TrainDriveState }>();
    const poses = new Map(this.world.bodies().map((b) => [b.id, b] as const));
    for (const [deviceId, live] of this.trains) {
      const pose = poses.get(live.bodyId);
      if (pose === undefined) continue;
      out.set(deviceId, { pose, drive: live.device.snapshotDrive() });
    }
    return out;
  }

  /** Snapshot the mechanical state of every tracked switch / gate device before a
   *  teardown. Only non-default state is recorded. */
  private snapshotDeviceState(): Map<string, DeviceState> {
    const out = new Map<string, DeviceState>();
    for (const [deviceId, position] of this.switchPositions) {
      out.set(deviceId, { kind: 'switch', position });
    }
    for (const [deviceId, withheld] of this.gateWithholds) {
      if (withheld.size > 0) out.set(deviceId, { kind: 'gate', withheld: [...withheld] });
    }
    /* The live tracking maps are now captured into the snapshot. Clear them so a deleted
     *  device's state doesn't linger: only devices that actually RESPAWN repopulate them
     *  via `restoreSwitch` / `restoreGate`; a deleted piece's entry is simply dropped. */
    this.switchPositions.clear();
    this.gateWithholds.clear();
    return out;
  }

  /** Re-assert a respawned gate's withholds (a raised span stays raised). */
  private restoreGate(deviceId: string, gate: GateDevice): void {
    const state = this.pendingDeviceState.get(deviceId);
    if (state?.kind !== 'gate') return;
    this.pendingDeviceState.delete(deviceId);
    const set = this.gateWithholds.get(deviceId) ?? new Set();
    for (const marker of state.withheld) {
      gate.hold(marker, 'reasserted after rebuild');
      set.add(marker);
    }
    this.gateWithholds.set(deviceId, set);
  }

  /** Throw a switch device by publishing a real `set_switch_position` command to its
   *  command topic (the device handles it + confirms `switch_state_changed`), tracking
   *  the position so it survives a rebuild. */
  private commandSwitch(deviceId: string, junctionMarkerId: string, position: string): void {
    this.switchPositions.set(deviceId, position);
    const envelope = {
      command_id: this.newId(),
      device_id: deviceId,
      timestamp_server: new Date(0).toISOString(),
      command_type: 'set_switch_position',
      protocol_version: PROTOCOL_VERSION,
      payload: { junction_marker_id: junctionMarkerId, position },
    };
    this.client.publish(
      topics.command(deviceId),
      new TextEncoder().encode(JSON.stringify(envelope)),
    );
  }

  // ---- vision -----------------------------------------------------------

  /** Snapshot every live train's bodies (loco + coupled carriages) in world space —
   *  what the fixed vision cameras perceive. Empty when no vision station is live. */
  private collectTrainBodies(): TrainBody[] {
    const poseById = new Map(this.world.bodies().map((b) => [b.id, b] as const));
    const out: TrainBody[] = [];
    for (const live of this.trains.values()) {
      const loco = poseById.get(live.bodyId);
      if (loco === undefined) continue;
      const bodies: VisionBody[] = [
        {
          pos: { x: loco.x, y: loco.y, rotationDeg: loco.rotationDeg },
          half: HALF_LEN.loco,
          colour: undefined,
        },
      ];
      for (const cid of live.carriageBodyIds) {
        const c = poseById.get(cid);
        if (c === undefined) continue;
        bodies.push({
          pos: { x: c.x, y: c.y, rotationDeg: c.rotationDeg },
          half: HALF_LEN.carriage,
          colour: c.color,
        });
      }
      out.push({ trainId: live.bodyId, bodies });
    }
    return out;
  }

  /** A vision station measured a train's length: assert `train_length_changed` from the
   *  station's own identity (ADR-023), with a hysteresis band so a noisy estimate
   *  doesn't emit a stream of events. */
  private onVisionLength(stationDeviceId: string, trainId: string, lengthMm: number): void {
    const train_length_mm = Math.round(lengthMm);
    const key = `${stationDeviceId}|${trainId}`;
    const last = this.visionReported.get(key);
    if (last !== undefined && Math.abs(last - train_length_mm) < VISION_HYSTERESIS_MM) return;
    this.visionReported.set(key, train_length_mm);
    this.platformFor(stationDeviceId).publish(
      this.event(stationDeviceId, 'train_length_changed', { train_id: trainId, train_length_mm }),
    );
  }

  // ---- stepping ---------------------------------------------------------

  /** Advance the world + every device by `ms`, in fixed `DT` frames. */
  private advance(ms: number): void {
    const ticks = Math.max(1, Math.round(ms / (DT * 1000)));
    for (let i = 0; i < ticks; i++) {
      this.world.step(DT);
      for (const { device } of this.yards.values()) device.step(DT);
      for (const { device } of this.trains.values()) device.step(DT);
    }
  }

  // ---- helpers ----------------------------------------------------------

  /** Each device gets its OWN platform over the shared broker — there is no single
   *  bridge any more; every device publishes / subscribes for itself, as on hardware. */
  private platformFor(deviceId: string): PlatformProvider {
    return mqttPlatform(this.client, deviceId, { newId: this.newId });
  }

  /** The marker points the marker sensors read — every logical marker at its world
   *  position, from the current layout. */
  private markerPoints(): Array<{ id: string; x: number; y: number }> {
    return this.layout.markers.map((m) => ({
      id: m.id,
      x: m.position?.x_mm ?? 0,
      y: m.position?.y_mm ?? 0,
    }));
  }

  /** The rail seat (segment + distance + facing) nearest a world point, oriented so the
   *  loco departs the way it points, or undefined when no rail is near. */
  private seatNearest(
    pos: { x: number; y: number },
    facing: { x: number; y: number },
  ): { segment: string; railPos: number; facing: 1 | -1 } | undefined {
    const at = this.world.nearestRail(pos.x, pos.y);
    const g = this.segmentEndpoints(at.segment);
    if (g === undefined) return undefined;
    /* The seat is on the rail's centre-line; the segment must lie near the placed piece
     *  (else there is no rail there and the train defers). */
    const segMid = { x: (g.start.x + g.end.x) / 2, y: (g.start.y + g.end.y) / 2 };
    const near = Math.min(
      Math.hypot(g.start.x - pos.x, g.start.y - pos.y),
      Math.hypot(g.end.x - pos.x, g.end.y - pos.y),
      Math.hypot(segMid.x - pos.x, segMid.y - pos.y),
    );
    if (near > 220) return undefined;
    /* Facing: +1 if the piece points along the rail's start→end direction, else -1. */
    const along = (g.end.x - g.start.x) * facing.x + (g.end.y - g.start.y) * facing.y;
    return { segment: at.segment, railPos: at.railPos, facing: along >= 0 ? 1 : -1 };
  }

  /** A segment's world endpoints, from the ONE compiled net's geometry — the operator's
   *  slots live in it alongside the running loop, so there is no separate yard geom. */
  private segmentEndpoints(
    seg: string,
  ): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined {
    return this.compiled.geom.get(seg);
  }

  private event(
    deviceId: string,
    eventType: CoreEvent['event_type'],
    payload: Record<string, unknown>,
  ): CoreEvent {
    return {
      event_id: this.newId(),
      device_id: deviceId,
      timestamp_device: new Date(0).toISOString(),
      event_type: eventType,
      protocol_version: PROTOCOL_VERSION,
      payload,
    } as unknown as CoreEvent;
  }

  private disconnectEvent(deviceId: string): CoreEvent {
    return this.event(deviceId, 'device_disconnected', {});
  }

  private teardownAllDevices(): void {
    for (const { device } of this.trains.values()) device.stop();
    for (const device of this.gates.values()) device.stop();
    for (const device of this.switches.values()) device.stop();
    for (const { device } of this.yards.values()) device.stop();
    this.trains.clear();
    this.gates.clear();
    this.switches.clear();
    this.yards.clear();
  }
}

/** Whether a piece carries a clearance gate (the gate piece or an experimental
 *  companion). */
function isGatePiece(p: TrackPiece): boolean {
  return p.type === 'gate' || p.type === 'crane-station' || p.type === 'lift-bridge';
}

/** An empty `YardLayout` for a stalled gantry (no fan of slots) — it reuses the
 *  compiled net so the device has a valid (if slot-less) layout. */
function emptyYardLayout(compiled: CompiledNetwork): YardLayout {
  return {
    net: compiled.net,
    geom: new Map(),
    leadWest: '',
    leadEast: '',
    slots: [],
    westSwitch: '',
    eastSwitch: '',
  };
}

/** A no-op switch actuator (for a stalled gantry). */
function noopActuator(): { set: (position: string) => void } {
  return { set: () => undefined };
}
