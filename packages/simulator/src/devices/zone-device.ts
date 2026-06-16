/**
 * A generic capacity-zone device (`core.gates_zone` + `core.reports_length`). It
 * owns a capacity-limited territory behind a single boundary marker (the throat)
 * and gates admission by its OWN asserted occupancy: while `occupancy >= capacity`
 * the scheduler denies clearance to the throat and holds an arriving train one
 * marker short; the moment a slot frees the device asserts a lower occupancy and
 * the scheduler admits the next train (ADR-026). It may also reconcile a train's
 * length on the way out (`core.reports_length`, ADR-023) — core trusts the count
 * and the length exactly as asserted; it never sees the interior (ADR-016).
 *
 * This is the GENERIC, directly-controllable zone — the `gates_zone` analog of
 * `GateDevice`. Occupancy is an INPUT it is told (by a crane camera in the real
 * yard; by the test here): `setOccupancy` / `fill` / `vacate` assert it and emit a
 * `zone_state_changed`. The full physics `YardZoneDevice` is the emergent-occupancy
 * implementation (it senses bodies shunted through a slot ladder); this one is for
 * focused scheduler tests + simple operator zones. Touches no world — world-agnostic
 * by construction (ADR-030/031). DOM-free, deterministic.
 */
import { type CoreEvent, type DeviceManifest, PROTOCOL_VERSION } from '@trainframe/protocol';
import type { PlatformProvider } from './platform-provider.js';

export interface ZoneDeviceDeps {
  /** The device↔core link (mqtt in the gate/script, in-process in unit tests). */
  readonly platform: PlatformProvider;
  /** The boundary marker (throat) at which admission is gated. */
  readonly zoneMarker: string;
  /** The zone's capacity (slots). */
  readonly capacity: number;
  /** Occupancy asserted at registration (default 0). */
  readonly initialOccupancy?: number;
  /** Fresh envelope id source. Defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Current ISO-8601 timestamp source. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

export class ZoneDevice {
  private readonly id: string;
  private readonly d: ZoneDeviceDeps;
  private readonly newId: () => string;
  private readonly now: () => string;
  private occ: number;

  constructor(deviceId: string, deps: ZoneDeviceDeps) {
    this.id = deviceId;
    this.d = deps;
    this.newId = deps.newId ?? defaultNewId;
    this.now = deps.now ?? defaultNow;
    this.occ = clamp(deps.initialOccupancy ?? 0, deps.capacity);
  }

  get deviceId(): string {
    return this.id;
  }

  /** The currently-asserted occupancy (for tests/inspection). */
  get occupancy(): number {
    return this.occ;
  }

  /** Register the `core.gates_zone` + `core.reports_length` manifest and publish
   *  the initial occupancy so the scheduler tracks the zone from the first tick. */
  start(): void {
    this.d.platform.register(this.manifest());
    this.d.platform.publish(this.registeredEvent());
    this.d.platform.publish(this.zoneEvent());
  }

  /** No-op teardown (the zone holds no subscriptions). Present for symmetry with
   *  the other devices' lifecycle. */
  stop(): void {}

  /** Assert a new occupancy (clamped to [0, capacity]) and emit `zone_state_changed`. */
  setOccupancy(occupancy: number): void {
    const next = clamp(occupancy, this.d.capacity);
    if (next === this.occ) return;
    this.occ = next;
    this.d.platform.publish(this.zoneEvent());
  }

  /** Fill every slot — the scheduler will hold an arriving train at the throat. */
  fill(): void {
    this.setOccupancy(this.d.capacity);
  }

  /** Free one slot — the scheduler admits the next held train. */
  vacate(): void {
    this.setOccupancy(this.occ - 1);
  }

  /** Reconcile a train's length on its way out (ADR-023): the yard shed a cut, so
   *  the train leaves shorter than it arrived. Core trusts the asserted length. */
  reportLength(trainId: string, lengthMm: number): void {
    this.d.platform.publish(
      this.envelope('train_length_changed', { train_id: trainId, train_length_mm: lengthMm }),
    );
  }

  private manifest(): DeviceManifest {
    return {
      manifest_version: '1.0',
      vendor: 'trainframe.sim',
      device_kind: 'railyard-zone',
      version: '0.1.0',
      protocol_version: PROTOCOL_VERSION,
      display_name: `Zone ${this.id}`,
      description: `A capacity-limited zone gating its throat at ${this.d.zoneMarker}.`,
      capabilities: ['core.gates_zone', 'core.reports_length'],
    };
  }

  private registeredEvent(): CoreEvent {
    return this.envelope('device_registered', {
      capabilities: ['core.gates_zone', 'core.reports_length'],
      device_kind_hint: 'railyard-zone',
    });
  }

  private zoneEvent(): CoreEvent {
    return this.envelope('zone_state_changed', {
      zone_marker_id: this.d.zoneMarker,
      capacity: this.d.capacity,
      occupancy: this.occ,
    });
  }

  /**
   * Build a `CoreEvent` envelope. The single sound coercion point in this file:
   * the protocol's `CoreEvent` union models payloads per `event_type`; we assemble
   * the open record the wire carries and coerce once, here. `event_type` is
   * constrained to the union's literals, so the discriminant is always valid.
   */
  private envelope(
    eventType: CoreEvent['event_type'],
    payload: Readonly<Record<string, unknown>>,
  ): CoreEvent {
    const env = {
      event_id: this.newId(),
      device_id: this.id,
      timestamp_device: this.now(),
      event_type: eventType,
      protocol_version: PROTOCOL_VERSION,
      payload,
    };
    return env as unknown as CoreEvent;
  }
}

function clamp(n: number, capacity: number): number {
  if (n < 0) return 0;
  if (n > capacity) return capacity;
  return n;
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}
