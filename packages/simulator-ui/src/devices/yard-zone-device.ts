/**
 * The RAILYARD as a `core.gates_zone` device driven by the REAL scheduler
 * (FROZEN SPEC §4; ADR-026/027/031/032). To core the yard is ONE opaque zone: a
 * boundary throat marker (`M-yard-throat`), a capacity, and ONE asserted
 * occupancy. Core never sees the interior ladder, the slots, or the carriages
 * (ADR-016) — it only consults the device-asserted occupancy to decide whether a
 * train may be cleared INTO the throat.
 *
 * The yard is IN-LINE on the running line (its spine IS the main loop's bottom
 * run), so it owns NO scheduler-thrown tap: a train passes straight through on the
 * default `thru` points, and only a service diverts it into a slot (the opaque
 * interior `Jw`/`Je`, which the device throws itself). Two core capabilities (the
 * manifest + the `device_registered` event):
 *   - `core.gates_zone` — admission at `M-yard-throat`. While `occupancy >=
 *     capacity` the scheduler's gate denies clearance to the throat and holds the
 *     approaching train one marker short (deny-and-hold, proven in
 *     `zone-admission.test.ts`).
 *   - `core.reports_length` — reconcile a train shortened by carriages shed into
 *     the yard (ADR-023), on its way out.
 * It MUST NOT declare `core.controls_motion`: it never drives a train across the
 * throat (the scheduler reclaims a released train under ordinary clearance —
 * scheduler `handleZoneTrainReleased`).
 *
 * NESTING (ADR-032): the visiting loco's own device stays on REAL core throughout.
 * Only the INTERIOR shunting is nested — the device owns a `ParentPlatform` and a
 * single `TrainDevice` (the unchanged manual-mode stub) wired from
 * `platformFor(interiorLocoId)`; the reused `YardController` drives that loco and
 * the crane through its phases (decouple a cut, migrate it to the spares slot).
 * The child reports upward only, never to the broker.
 *
 * Admission → service → release, per resident train (single-mover interior,
 * ADR-026 §4 — at most one `YardController` runs at a time):
 *   - the device senses (by its crane-camera, never world ground truth) a train
 *     arriving at the throat, bumps occupancy → `zone_state_changed`;
 *   - it runs a `YardController` service on that train;
 *   - on `done` it emits `zone_train_released` (and `train_length_changed` if a
 *     cut was shed), frees the slot → `zone_state_changed`, admitting the next.
 *
 * Tick-driven over a virtual clock; pure (no DOM, no Date.now, no Math.random).
 */
import { type CoreEvent, PROTOCOL_VERSION } from '@trainframe/protocol';
import type { DeviceManifest } from '@trainframe/protocol';
import type { YardLayout } from '../physics/yard.js';
import { Crane } from './crane.js';
import type { MotorActuator } from './motor-actuator.js';
import { ParentPlatform } from './parent-platform.js';
import type { CommandHandler, PlatformProvider } from './platform-provider.js';
import type { SwitchActuator } from './switch-actuator.js';
import { TrainDevice } from './train-device.js';
import { type Sighting, YardController, craneBounds } from './yard-controller.js';

/** A fixed envelope timestamp for events the device publishes. The device is pure
 *  (no Date.now); the integrator's broker stamps `timestamp_server`. A well-formed
 *  ISO-8601 keeps the wire shape valid. */
const EVENT_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** The crane camera footprint radius (mm) — the device knows its own sensor. */
const CAMERA_RADIUS = 20;

/** Length (mm) a shed cut removes from a serviced train, reported via
 *  `core.reports_length`. Two carriages at the yard's car spacing. */
const SHED_LENGTH_MM = 136;

/** The interior shunting loco's device id on the parent↔child seam. INTERIOR to
 *  the zone — never seen by core (ADR-032). A v4-UUID so the seam carries valid
 *  wire shapes if ever bridged out. */
const INTERIOR_LOCO_ID = '0a0d0001-0000-4000-8000-000000000001';

/** The opaque-yard layout the zone device needs — the throat marker it gates, the
 *  drive-through `YardLayout` (slot geometry + leads), and which slots the visitor
 *  enters and the spares occupy. PURE layout data — NOT the track. Any yard shape
 *  (the bezier `BranchingScene`, the parallelogram drive-through) satisfies it, so
 *  ONE zone device + ONE `YardController` swap serve every yard. */
export interface YardZoneScene {
  readonly yard: YardLayout;
  readonly throatMarker: string;
  /** The slot the INITIAL spares cut is stabled in. From here it rotates: each serviced
   *  visitor's shed cut becomes the next visitor's spares, in the visitor's own slot. */
  readonly sparesSlot: string;
  /** Where the visitor PARKS at the throat — the world point the throat camera reads.
   *  For an IN-LINE yard this is the west lead's start (the default). For a DETOUR
   *  yard the throat sits on the running line, across the divert + lead-in from the
   *  lead, so the composition supplies it explicitly. */
  readonly throatPoint?: { x: number; y: number };
}

export interface YardZoneDeps {
  /** The device's link to REAL core (the broker in the gate/script, an in-process
   *  bus in unit tests). */
  readonly platform: PlatformProvider;
  /** The yard's layout: throat marker, drive-through layout (slot geom), entry/spares
   *  slots. PURE layout data — NOT the track. */
  readonly scene: YardZoneScene;
  /** Total slots the zone admits into (= slotCount − reserved spares). */
  readonly capacity: number;
  /* The device perceives + acts ONLY through these injected providers — it never
   * touches the simulator (the composition root binds them to the sim; on
   * hardware they bind to GPIO/CV). ADR-030/031. */
  /** The interior ladder points (opaque to core). */
  readonly westPoints: SwitchActuator;
  readonly eastPoints: SwitchActuator;
  /** The crane camera: what is beneath the footprint at world (x,y). */
  readonly look: (x: number, y: number) => Sighting;
  /** Lower the wedge at world (x,y) to split the coupling there. */
  readonly wedgeAt: (x: number, y: number) => void;
  /** The throat camera: the id of the train sighted within `r` of (x,y), or null —
   *  the device reads the arriving loco's tag, never the world's body list. */
  readonly sightedTrainAt: (x: number, y: number, r: number) => string | null;
  /** The visiting loco's motor (the interior controller self-drives it). */
  readonly motorFor: (trainId: string) => MotorActuator;
}

/** A train resident in the yard: its core id (the id core knows it by, == the
 *  interior loco body id the world steps) and — once it becomes the active service —
 *  the slot it pulls into and the controller servicing it. Slot + controller are bound
 *  LAZILY at service start (not at admit), so the controller always sees the CURRENT
 *  spares (which rotates as each prior visitor leaves its cut behind). */
interface Resident {
  readonly trainId: string;
  controller: YardController | null;
  /** The free slot this visitor pulls into (its shed cut stays here, becoming the next
   *  visitor's spares). Assigned when its service starts. */
  entrySlot: string | null;
  /** Whether release + length reconciliation have already been emitted. */
  released: boolean;
}

export class YardZoneDevice {
  private readonly deviceId: string;
  private readonly d: YardZoneDeps;
  private unsubscribe: (() => void) | null = null;

  /** The parent side of the ADR-032 nesting seam: this device is core to the
   *  interior shunting loco, wired from `platformFor(INTERIOR_LOCO_ID)`. */
  private readonly child = new ParentPlatform();

  /** The single persistent gantry crane, shared across services so its head only
   *  ever travels (never jumps between services). The device steps it. */
  private readonly crane: Crane;
  /** Interior ladder switch actuators (opaque to core). */
  private readonly westPoints: SwitchActuator;
  private readonly eastPoints: SwitchActuator;

  /** Trains resident inside the zone, one per occupied slot. At most one is
   *  serviced at a time (single-mover interior, ADR-026 §4). */
  private readonly residents: Resident[] = [];
  /** Trains the device has sensed arriving at the throat this run, so it bumps
   *  occupancy exactly once per visit. */
  private readonly admitted = new Set<string>();

  /** Monotonic counter for deterministic envelope ids (the device stays pure). */
  private seq = 0;

  /** Which slot currently holds the pick-up-able SPARES cut. It ROTATES: each serviced
   *  visitor leaves its own shed cut in its entry slot, and that cut becomes the spares
   *  for the next visitor (the old spares having left coupled to the train). */
  private sparesSlot: string;
  /** Round-robin cursor over the slots, so successive visitors spread across ALL of
   *  them rather than reusing the same one or two. */
  private entryHint = 0;

  constructor(deviceId: string, deps: YardZoneDeps) {
    this.deviceId = deviceId;
    this.d = deps;
    this.sparesSlot = deps.scene.sparesSlot;
    const bounds = craneBounds(deps.scene.yard);
    this.crane = new Crane(bounds, {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    });
    this.westPoints = deps.westPoints;
    this.eastPoints = deps.eastPoints;
  }

  /** A free slot for the next visitor to pull into — not the spares slot, not a slot a
   *  not-yet-departed resident is already using — scanned round-robin so all slots get
   *  used over time. */
  private pickFreeSlot(): string {
    const slots = this.d.scene.yard.slots;
    const taken = new Set<string>([this.sparesSlot]);
    for (const r of this.residents) if (r.entrySlot !== null) taken.add(r.entrySlot);
    for (let i = 0; i < slots.length; i++) {
      const idx = (this.entryHint + i) % slots.length;
      const slot = slots[idx];
      if (slot !== undefined && !taken.has(slot)) {
        this.entryHint = (idx + 1) % slots.length;
        return slot;
      }
    }
    /* Every slot taken (should not happen below capacity): fall back to the spares slot
     *  so the controller still has a defined target. */
    return this.sparesSlot;
  }

  /** The platform provider the interior loco is wired from (ADR-032). To it this
   *  device IS core; it cannot tell the difference from the broker. */
  platformFor(childId: string = INTERIOR_LOCO_ID): PlatformProvider {
    return this.child.platformFor(childId);
  }

  /** Announce to core (manifest + a `device_registered` event with the gates_zone
   *  + reports_length capabilities) and publish the initial occupancy. Sets the
   *  interior ladder points to the through (spine) position so a non-serviced
   *  train runs straight through the in-line yard from the first tick. */
  start(): void {
    this.westPoints.set('thru');
    this.eastPoints.set('thru');
    this.d.platform.register(this.manifest());
    /* The scheduler reads the gates_zone capability off the `device_registered`
     *  EVENT payload — the manifest register ships only capabilities + kind. This
     *  mirrors the existing convention (ScheduledTrainDevice ships train_length_mm
     *  the same way); the device's surface stays additive (ADR-031). */
    this.d.platform.publish(this.registeredEvent());
    this.announce();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get capacity(): number {
    return this.d.capacity;
  }

  /** The device's asserted occupancy — resident trains (the one number core sees
   *  for the whole opaque zone, ADR-032 §2). Sensed by the device, never world
   *  ground truth. */
  get occupancy(): number {
    return this.residents.length;
  }

  /** Where the gantry crane head physically is, for rendering. */
  get cranePos(): { x: number; y: number } {
    return this.crane.pos;
  }

  private manifest(): DeviceManifest {
    return {
      manifest_version: '1.0',
      vendor: 'trainframe.sim',
      device_kind: 'railyard',
      version: '0.1.0',
      protocol_version: PROTOCOL_VERSION,
      display_name: 'Railyard',
      description: 'A capacity-limited opaque shunting yard gating its throat.',
      capabilities: ['core.gates_zone', 'core.reports_length'],
    };
  }

  /** The `device_registered` event announcing the in-line zone's capabilities. The
   *  yard owns no scheduler-thrown tap (it is in-line on the running line), so the
   *  event carries no switch pairing. */
  private registeredEvent(): CoreEvent {
    return {
      event_id: this.nextId(),
      device_id: this.deviceId,
      timestamp_device: EVENT_TIMESTAMP,
      event_type: 'device_registered',
      protocol_version: PROTOCOL_VERSION,
      payload: {
        capabilities: ['core.gates_zone', 'core.reports_length'],
        device_kind_hint: 'railyard',
      },
    };
  }

  /** Step the interior: sense fresh arrivals at the throat, advance each
   *  resident's service, and step the shared crane. */
  step(dtS: number): void {
    this.senseArrivals();
    this.serviceResidents(dtS);
    this.crane.step(dtS);
  }

  /** Detect a train newly arrived at (and stopped near) the throat by its
   *  crane-camera, and begin servicing it — bumping occupancy. The device knows a
   *  train by the body id core routed to the throat (tag id == train id == body
   *  id, the seeded identity convention). It senses presence, never reads the
   *  world's coupling/length ground truth. */
  private senseArrivals(): void {
    if (this.residents.length >= this.d.capacity) return; // full — no room to admit
    const throat = this.throatWorldPoint();
    /* The throat camera reads the arriving loco's tag (id) — the device never sees
     *  the world's body list. */
    const arrival = this.d.sightedTrainAt(throat.x, throat.y, CAMERA_RADIUS * 4);
    if (arrival === null || this.admitted.has(arrival)) return;
    this.admit(arrival);
  }

  /** Admit a newly-arrived train as a resident (queued). Its slot + controller are NOT
   *  bound yet — that happens when it becomes the active service, so it picks up the
   *  spares as they stand THEN (after any earlier visitor has rotated them). */
  private admit(trainId: string): void {
    this.admitted.add(trainId);
    this.residents.push({ trainId, controller: null, entrySlot: null, released: false });
    this.announce();
  }

  /** Build a `YardController` for the visiting train, pulling into `entrySlot` and
   *  collecting the spares from the CURRENT `sparesSlot`. The controller drives the
   *  train's own body (it self-drives the real interior rails) through the crane camera
   *  + wedge + ladder points. */
  private makeController(trainId: string, entrySlot: string): YardController {
    const train = new TrainDevice(trainId, this.d.motorFor(trainId));
    return new YardController({
      layout: this.d.scene.yard,
      train,
      westPoints: this.westPoints,
      eastPoints: this.eastPoints,
      look: this.d.look,
      cameraRadius: CAMERA_RADIUS,
      wedgeAt: this.d.wedgeAt,
      crane: this.crane,
      entrySlot,
      sparesSlot: this.sparesSlot,
    });
  }

  /** Advance the single active service (single-mover interior). The active resident
   *  binds its slot + controller lazily on its first tick (so it gets the current
   *  spares); release a train whose service is `done`. */
  private serviceResidents(dtS: number): void {
    const active = this.residents.find((r) => !r.released);
    if (active === undefined) return;
    if (active.controller === null) {
      active.entrySlot = this.pickFreeSlot();
      active.controller = this.makeController(active.trainId, active.entrySlot);
    }
    active.controller.tick(dtS);
    if (active.controller.currentPhase === 'done') this.release(active);
  }

  /** Release a serviced train to core: emit `zone_train_released` (+ a length
   *  reconcile if a cut was shed), drop the slot, and re-announce occupancy so the
   *  next queued train is admitted. The device never drives it across the throat. */
  private release(resident: Resident): void {
    resident.released = true;
    this.d.platform.publish(this.releasedEvent(resident.trainId));
    this.d.platform.publish(this.lengthChanged(resident.trainId));
    const idx = this.residents.indexOf(resident);
    if (idx !== -1) this.residents.splice(idx, 1);
    this.admitted.delete(resident.trainId);
    /* ROTATE THE SPARES: the train has driven off coupled to the old spares, leaving its
     *  OWN shed cut in its entry slot. That cut is now the spares the NEXT visitor picks
     *  up — the old spares slot is empty. (If the service never bound a slot — a
     *  defensive guard — the spares stand.) */
    if (resident.entrySlot !== null) this.sparesSlot = resident.entrySlot;
    /* Restore the interior ladder to neutral so the next NON-serviced train runs
     *  straight through and the just-released train continues onto the main loop. */
    this.westPoints.set('thru');
    this.eastPoints.set('thru');
    this.announce();
  }

  private releasedEvent(trainId: string): CoreEvent {
    return {
      event_id: this.nextId(),
      device_id: this.deviceId,
      timestamp_device: EVENT_TIMESTAMP,
      event_type: 'zone_train_released',
      protocol_version: PROTOCOL_VERSION,
      payload: { zone_marker_id: this.d.scene.throatMarker, train_id: trainId },
    };
  }

  /** Reconcile a shed-cut train's length (ADR-023). Reports the train shorter by
   *  the shed cut — honoured because the device declared `core.reports_length`. */
  private lengthChanged(trainId: string): CoreEvent {
    return {
      event_id: this.nextId(),
      device_id: this.deviceId,
      timestamp_device: EVENT_TIMESTAMP,
      event_type: 'train_length_changed',
      protocol_version: PROTOCOL_VERSION,
      payload: { train_id: trainId, train_length_mm: SHED_LENGTH_MM },
    };
  }

  /** Re-publish the zone's capacity + current occupancy (`zone_state_changed`). */
  private announce(): void {
    this.d.platform.publish({
      event_id: this.nextId(),
      device_id: this.deviceId,
      timestamp_device: EVENT_TIMESTAMP,
      event_type: 'zone_state_changed',
      protocol_version: PROTOCOL_VERSION,
      payload: {
        zone_marker_id: this.d.scene.throatMarker,
        capacity: this.d.capacity,
        occupancy: this.residents.length,
      },
    });
  }

  /** The throat's world point (where a visitor parks). An explicit `throatPoint`
   *  (the detour case) wins; otherwise the west lead's start (the in-line case). */
  private throatWorldPoint(): { x: number; y: number } {
    if (this.d.scene.throatPoint !== undefined) return this.d.scene.throatPoint;
    const g = this.d.scene.yard.geom.get(this.d.scene.yard.leadWest);
    if (g === undefined) return { x: 0, y: 0 };
    return { x: g.ax, y: g.ay };
  }

  /** A deterministic, structurally-valid v4-UUID for an event envelope — the
   *  monotonic counter encoded in the final field, so the device stays pure (no
   *  Math.random / Date.now) while every event carries a valid wire id. */
  private nextId(): string {
    this.seq += 1;
    const tail = this.seq.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${tail}`;
  }
}
