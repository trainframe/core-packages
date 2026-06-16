/**
 * The reverse-in RAILYARD as a `core.gates_zone` device (ADR-026/027/031/034), for
 * the real-piece trailing-turnout ladder. To core the yard is ONE opaque zone: a
 * boundary throat marker, a capacity, and ONE asserted occupancy. Core never sees
 * the interior ladder, the slots, or the carriages — it only consults the
 * device-asserted occupancy to decide whether a train may be cleared INTO the throat.
 *
 * The "metal frame stretched over the track" (ADR-034): on registration the device
 * DECLARES the markers it owns — the throat + the interior switches under the frame
 * — in `owned_marker_ids`. Core records that ownership and refuses to let anything
 * else control a marker under the frame. The device derives the list from its own
 * footprint (the composition root hands it the list); core never computes geometry.
 *
 * Admission → reverse-in service → release, per resident train (single-mover
 * interior, ADR-026 §4): the device senses (by its crane camera) a train arriving at
 * the throat, bumps occupancy, runs a `LadderYardController` that backs the rake into
 * a free slot and pulls the loco clear, then emits `zone_train_released` (+ a length
 * reconcile for the shed cut) and frees the slot — admitting the next.
 *
 * Tick-driven over a virtual clock; pure (no DOM, no Date.now, no Math.random).
 */
import { type CoreEvent, type DeviceManifest, PROTOCOL_VERSION } from '@trainframe/protocol';
import { Crane, type CraneBounds } from './crane.js';
import { LadderYardController, type Sighting, type SlotGeom } from './ladder-yard-controller.js';
import type { MotorActuator } from './motor-actuator.js';
import type { PlatformProvider } from './platform-provider.js';
import type { SwitchActuator } from './switch-actuator.js';
import { TrainDevice } from './train-device.js';

/** A fixed envelope timestamp; the integrator's broker stamps `timestamp_server`. */
const EVENT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
/** The crane camera footprint radius (mm) — the device knows its own sensor. */
const CAMERA_RADIUS = 30;
/** Length (mm) a shed cut removes from a serviced train (ADR-023). Two cars. */
const SHED_LENGTH_MM = 136;

export interface RailyardZoneDeps {
  /** The device's link to REAL core. */
  readonly platform: PlatformProvider;
  /** The zone boundary marker (the throat — the gates_zone admission point). */
  readonly throatMarker: string;
  /** The interior markers + switches the frame owns (ADR-034). The composition root
   *  computes this from the yard's footprint; core only records it. */
  readonly ownedMarkerIds: readonly string[];
  /** Slots the zone admits into. */
  readonly capacity: number;
  /* The device perceives + acts ONLY through these injected providers (ADR-030/031). */
  readonly throat: SwitchActuator;
  readonly ladder: readonly SwitchActuator[];
  readonly enterPos: string;
  readonly thruPos: string;
  readonly ladderThruPos: string;
  readonly ladderSlotPos: string;
  /** Each slot's world geometry (mouth + buffer). */
  readonly slots: readonly SlotGeom[];
  /** Where a pulled-in loco rests on the headshunt. */
  readonly headshuntRest: { x: number; y: number };
  /** The gantry crane's travel limits. */
  readonly craneBounds: CraneBounds;
  /** The throat world point (where an arriving loco parks to be sensed). */
  readonly throatPoint: { x: number; y: number };
  /** The crane camera: what is beneath the footprint at world (x,y). */
  readonly look: (x: number, y: number) => Sighting;
  /** Lower the wedge at world (x,y) to split the coupling there. */
  readonly wedgeAt: (x: number, y: number) => void;
  /** The throat camera: the id of the loco sighted within `r` of (x,y), or null. */
  readonly sightedTrainAt: (x: number, y: number, r: number) => string | null;
  /** The visiting loco's motor (the interior controller self-drives it). */
  readonly motorFor: (trainId: string) => MotorActuator;
}

interface Resident {
  readonly trainId: string;
  readonly controller: LadderYardController;
  released: boolean;
}

export class RailyardZoneDevice {
  private readonly deviceId: string;
  private readonly d: RailyardZoneDeps;
  private readonly crane: Crane;
  private readonly residents: Resident[] = [];
  private readonly admitted = new Set<string>();
  private seq = 0;

  constructor(deviceId: string, deps: RailyardZoneDeps) {
    this.deviceId = deviceId;
    this.d = deps;
    this.crane = new Crane(deps.craneBounds, {
      x: (deps.craneBounds.minX + deps.craneBounds.maxX) / 2,
      y: deps.craneBounds.minY,
    });
  }

  /** Announce to core (manifest + a `device_registered` event carrying the
   *  gates_zone + reports_length capabilities AND the owned-marker declaration), set
   *  the throat to the running line, and publish the initial occupancy. */
  start(): void {
    this.d.throat.set(this.d.thruPos);
    for (const sw of this.d.ladder) sw.set(this.d.ladderThruPos);
    this.d.platform.register(this.manifest());
    this.d.platform.publish(this.registeredEvent());
    this.announce();
  }

  stop(): void {
    /* No broker subscription to tear down — the device is tick-driven. */
  }

  get capacity(): number {
    return this.d.capacity;
  }

  /** The device's asserted occupancy (resident trains) — the one number core sees. */
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
      description: 'A capacity-limited opaque reverse-in shunting yard gating its throat.',
      capabilities: ['core.gates_zone', 'core.reports_length'],
    };
  }

  /** The `device_registered` event: capabilities + the owned-marker declaration (the
   *  track "under the frame", ADR-034). */
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
        owned_marker_ids: [...this.d.ownedMarkerIds],
      },
    };
  }

  /** Step the interior: sense fresh arrivals, advance the active service, step the
   *  shared crane. */
  step(dtS: number): void {
    this.senseArrivals();
    this.serviceResidents(dtS);
    this.crane.step(dtS);
  }

  /** Sense a train newly arrived at the throat (by the throat camera) and begin
   *  servicing it — bumping occupancy. */
  private senseArrivals(): void {
    if (this.residents.length >= this.d.capacity) return;
    const t = this.d.throatPoint;
    const arrival = this.d.sightedTrainAt(t.x, t.y, CAMERA_RADIUS * 4);
    if (arrival === null || this.admitted.has(arrival)) return;
    this.admit(arrival);
  }

  private admit(trainId: string): void {
    this.admitted.add(trainId);
    this.residents.push({ trainId, controller: this.makeController(trainId), released: false });
    this.announce();
  }

  private makeController(trainId: string): LadderYardController {
    return new LadderYardController({
      train: new TrainDevice(trainId, this.d.motorFor(trainId)),
      throat: this.d.throat,
      enterPos: this.d.enterPos,
      thruPos: this.d.thruPos,
      ladder: this.d.ladder,
      ladderThruPos: this.d.ladderThruPos,
      ladderSlotPos: this.d.ladderSlotPos,
      slots: this.d.slots,
      headshuntRest: this.d.headshuntRest,
      look: this.d.look,
      cameraRadius: CAMERA_RADIUS,
      wedgeAt: this.d.wedgeAt,
      crane: this.crane,
    });
  }

  private serviceResidents(dtS: number): void {
    const active = this.residents.find((r) => !r.released);
    if (active === undefined) return;
    active.controller.tick(dtS);
    if (active.controller.currentPhase === 'done') this.release(active);
  }

  /** Release a serviced train to core: emit `zone_train_released` (+ a length
   *  reconcile for the shed cut), drop the slot, restore the throat to the running
   *  line, and re-announce occupancy so the next queued train is admitted. */
  private release(resident: Resident): void {
    resident.released = true;
    this.d.platform.publish(this.releasedEvent(resident.trainId));
    this.d.platform.publish(this.lengthChanged(resident.trainId));
    const idx = this.residents.indexOf(resident);
    if (idx !== -1) this.residents.splice(idx, 1);
    this.admitted.delete(resident.trainId);
    this.d.throat.set(this.d.thruPos);
    for (const sw of this.d.ladder) sw.set(this.d.ladderThruPos);
    this.announce();
  }

  private releasedEvent(trainId: string): CoreEvent {
    return {
      event_id: this.nextId(),
      device_id: this.deviceId,
      timestamp_device: EVENT_TIMESTAMP,
      event_type: 'zone_train_released',
      protocol_version: PROTOCOL_VERSION,
      payload: { zone_marker_id: this.d.throatMarker, train_id: trainId },
    };
  }

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

  private announce(): void {
    this.d.platform.publish({
      event_id: this.nextId(),
      device_id: this.deviceId,
      timestamp_device: EVENT_TIMESTAMP,
      event_type: 'zone_state_changed',
      protocol_version: PROTOCOL_VERSION,
      payload: {
        zone_marker_id: this.d.throatMarker,
        capacity: this.d.capacity,
        occupancy: this.residents.length,
      },
    });
  }

  /** A deterministic, structurally-valid v4-UUID for an event envelope. */
  private nextId(): string {
    this.seq += 1;
    const tail = this.seq.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${tail}`;
  }
}
