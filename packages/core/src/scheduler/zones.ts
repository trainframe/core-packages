import type { DeviceTable } from './devices.js';
import { type SchedulerEffect, clearanceStateEffect, effects } from './effects.js';
import type { ClearanceRetry, MarkerOwnership, ScheduleAdvance } from './seams.js';
import type { TrainRoster } from './train-roster.js';
import type { TrainState } from './train-state.js';

/**
 * Core's side of `core.gates_zone` devices: the boundary markers zones gate
 * (ADR-027), the interior markers frames own (ADR-034), suspending a train that
 * pulls into a zone, reclaiming it on `zone_train_released`, and refusing a
 * route into a zone to a train that cannot reverse. Admission itself is the
 * capability's hook; this owns only what the scheduler must know about zones.
 */
export class ZoneAuthority {
  /**
   * Zone boundary marker id → owning `core.gates_zone` device id (ADR-027).
   * Populated from `zone_state_changed`. Lets the scheduler recognise a zone
   * boundary so it can suspend a train that pulls in (entry) and gate admission
   * on `core.can_reverse`.
   */
  private readonly boundaries = new Map<string, string>();
  /**
   * Interior marker id → owning `core.gates_zone` device id (ADR-034). Populated
   * from `owned_marker_ids` on `device_registered`: the track "under the frame".
   * Core only RECORDS the declared list; it never computes which markers fall
   * under a frame (the device derives that from its own footprint, ADR-031). It
   * enforces single ownership: nothing else may control a marker a frame owns.
   */
  private readonly ownedMarkers = new Map<string, string>();

  constructor(
    private readonly devices: Pick<DeviceTable, 'declares' | 'stateEffect'>,
    private readonly trains: Pick<TrainRoster, 'get' | 'values'>,
    private readonly ownership: Pick<MarkerOwnership, 'switchOwnerOf'>,
    private readonly clearance: ClearanceRetry,
    private readonly schedules: ScheduleAdvance,
  ) {}

  /** The `core.gates_zone` device that owns `markerId` as interior (under its
   *  frame, ADR-034), or undefined if no frame has declared it. */
  ownerOf(markerId: string): string | undefined {
    return this.ownedMarkers.get(markerId);
  }

  /**
   * Record the interior markers a `core.gates_zone` device declares it owns
   * (ADR-034). Single ownership is enforced: a marker already owned by another
   * device (a second frame, or a switch device already controlling it) is
   * refused with an anomaly and left with its first owner, because two things
   * cannot own the same piece of track.
   */
  recordOwnership(deviceId: string, owned: unknown): ReadonlyArray<SchedulerEffect> {
    if (!Array.isArray(owned)) return [];
    const anomalies: SchedulerEffect[] = [];
    for (const markerId of owned) {
      if (typeof markerId !== 'string') continue;
      const zoneOwner = this.ownedMarkers.get(markerId);
      const switchOwner = this.ownership.switchOwnerOf(markerId);
      const conflict =
        (zoneOwner !== undefined && zoneOwner !== deviceId) ||
        (switchOwner !== undefined && switchOwner !== deviceId);
      if (conflict) {
        const other = zoneOwner ?? switchOwner;
        anomalies.push(
          effects.publishEvent('anomaly', {
            severity: 'warning',
            description: `Device ${deviceId} cannot own marker ${markerId}: already owned by ${other}`,
          }),
        );
        continue;
      }
      this.ownedMarkers.set(markerId, deviceId);
    }
    return anomalies;
  }

  /**
   * Record the zone's boundary marker from a `zone_state_changed`, so the
   * scheduler can recognise it for entry suspension and the reverse-admission
   * gate. The event still goes on to the `core.gates_zone` capability.
   */
  recordBoundary(deviceId: string, payload: unknown): void {
    const { zone_marker_id } = payload as { zone_marker_id?: string };
    if (typeof zone_marker_id === 'string') {
      this.boundaries.set(zone_marker_id, deviceId);
    }
  }

  /**
   * Reverse-admission gate (ADR-027): a zone interior is worked by shunting,
   * which needs reversing. A train routed INTO a zone (its terminus is a zone
   * boundary) must declare `core.can_reverse`, or it would pull in and get
   * stuck, so the route is refused with this anomaly. A pass-through train
   * (terminus past the boundary) is unaffected.
   */
  admissionRefusal(train: TrainState, targetStop: string): SchedulerEffect | undefined {
    if (!this.boundaries.has(targetStop)) return undefined;
    if (this.devices.declares(train.train_id, 'core.can_reverse')) return undefined;
    return effects.publishEvent('anomaly', {
      severity: 'warning',
      description: `Train ${train.train_id} routed into zone ${targetStop} without core.can_reverse; refusing admission`,
    });
  }

  /**
   * True if an admitted train arriving at `markerId` is pulling into a zone:
   * the marker is a zone boundary and the train's route terminates there (a
   * pass-through train, whose terminus lies past the boundary, is not entering).
   * ADR-027 §2.
   */
  isEntry(train: TrainState, markerId: string): boolean {
    return this.boundaries.has(markerId) && transitTerminatesAt(train, markerId);
  }

  /**
   * An admitted train has reached a zone boundary as its route terminus and is
   * pulling into the device's opaque interior. Suspend it: it holds no core
   * block (the throat frees for the next admission), core routes it no further,
   * and it stays put until the owning device emits `zone_train_released`. Zone
   * fullness is the device's asserted count (ADR-026), not block exclusivity.
   */
  enter(train: TrainState, markerId: string): ReadonlyArray<SchedulerEffect> {
    train.in_zone = markerId;
    train.transit = undefined;
    // Preserve the arrival heading before dropping the edge, so the zone resume
    // sends the train onward (out the far side) instead of reversing back in.
    train.zone_entry_edge = train.current_edge;
    train.current_edge = undefined;
    train.clearance_limit_marker_id = markerId;
    const hadEdges = train.cleared_edges.length > 0;
    train.cleared_edges = [];

    const out: SchedulerEffect[] = [];
    if (hadEdges) out.push(clearanceStateEffect(train));
    // The throat (and approach) just freed: let a waiting train be admitted.
    out.push(...this.clearance.retryBlockedClearances());
    return out;
  }

  /**
   * The owning device releases a held train back to core authority. Reclaim it
   * at the throat: clear `in_zone` and resume normal scheduling. The train
   * departs onward only under ordinary clearance (main-line block exclusivity
   * holds; the device never drives a train across the throat). Honoured only
   * from the device that owns the zone boundary.
   */
  handleTrainReleased(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { zone_marker_id, train_id } = payload as {
      zone_marker_id: string;
      train_id: string;
    };

    if (this.boundaries.get(zone_marker_id) !== deviceId) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Device ${deviceId} released a train from zone ${zone_marker_id} it does not own`,
        }),
      ];
    }

    const train = this.trains.get(train_id);
    if (!train || train.in_zone !== zone_marker_id) return [];

    train.in_zone = undefined;

    /* Cyclic resume (ADR-028): if the train is running a schedule whose CURRENT
     * stop is this yard, the yard was just a stop on its loop, so advance the
     * schedule and plan the onward leg itself, exactly as a station dwell does
     * on expiry. The train drives out under ordinary clearance (block
     * exclusivity still holds; the device only released it, it did not move
     * it). Otherwise this was a one-off route into the yard: leave the train
     * parked at the throat, reclaimed, awaiting a fresh route. Either branch
     * retries peers that may have been waiting on the freed throat. */
    if (
      train.schedule &&
      train.schedule.stops[train.schedule.current_stop_index] === zone_marker_id
    ) {
      return this.schedules.advanceScheduleAndReplan(train);
    }
    return [...this.clearance.retryBlockedClearances()];
  }

  /**
   * Drop the interior markers a departing zone device owned and the boundaries
   * it gated. A train suspended inside a vanished zone has no known position
   * any more (the zone held it in its opaque interior), so it goes back off the
   * map (ADR-036) and must be introduced again before it is routed.
   */
  forgetDevice(deviceId: string): ReadonlyArray<SchedulerEffect> {
    for (const [markerId, owner] of [...this.ownedMarkers]) {
      if (owner === deviceId) this.ownedMarkers.delete(markerId);
    }
    const out: SchedulerEffect[] = [];
    for (const [boundaryMarkerId, owner] of [...this.boundaries]) {
      if (owner !== deviceId) continue;
      this.boundaries.delete(boundaryMarkerId);
      for (const train of this.trains.values()) {
        if (train.in_zone === boundaryMarkerId) {
          out.push(...this.takeOffMapAfterZoneLoss(train, deviceId));
        }
      }
    }
    return out;
  }

  reset(): void {
    this.boundaries.clear();
    this.ownedMarkers.clear();
  }

  private takeOffMapAfterZoneLoss(
    train: TrainState,
    zoneDeviceId: string,
  ): ReadonlyArray<SchedulerEffect> {
    train.in_zone = undefined;
    train.introduced = undefined;
    train.last_marker_id = undefined;
    train.current_edge = undefined;
    train.zone_entry_edge = undefined;
    train.transit = undefined;
    train.dwell_until = undefined;
    return [
      effects.publishEvent('anomaly', {
        severity: 'warning',
        description: `Zone device ${zoneDeviceId} disconnected with train ${train.train_id} inside; its position is unknown and it must be introduced again`,
      }),
      this.devices.stateEffect(train.train_id, train),
    ];
  }
}

/** True if `markerId` is the terminus of the train's current transit. */
function transitTerminatesAt(train: TrainState, markerId: string): boolean {
  if (!train.transit) return false;
  const idx = train.transit.progress_index;
  return (
    train.transit.edges[idx]?.to_marker_id === markerId && idx + 1 >= train.transit.edges.length
  );
}
