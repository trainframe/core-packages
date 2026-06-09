import type { VirtualCarriage, VirtualTrain } from './virtual-train.js';

interface RailyardEvent {
  event_type: string;
  device_id: string;
  payload: unknown;
}

/** How many leading wagons the yard swaps per visiting train. */
const SWAP_PAIR_SIZE = 2;

/**
 * Ticks a train must sit parked at the throat before the yard services it. The
 * train parks physically the instant it reaches the throat, but the scheduler
 * only suspends it (ADR-027 `in_zone`) once it has processed the bridged
 * marker read — a few ticks later. Releasing before that suspend lands would be
 * dropped by the scheduler (it checks `in_zone`), stranding the train. The
 * dwell lets the suspend settle first. It also reads as the yard "working" the
 * consist for a beat rather than teleporting it.
 */
const DWELL_TICKS = 4;

/**
 * A virtual railyard: a `core.gates_zone` device owning a capacity-limited
 * territory behind a single boundary marker (the throat). It admits trains by
 * its OWN asserted occupancy — a slot may be filled by a parked consist OR by a
 * cut of carriages with no locomotive, which core cannot see (carriages are
 * invisible to core, ADR-016). See ADR-026 and
 * `docs/experimental/006-railyard.md`.
 *
 * Scalable to N slots: construct with any capacity. Occupancy is the count of
 * filled slots; the `core.gates_zone` capability denies admission to the
 * boundary marker while `occupancy >= capacity`, and the scheduler's existing
 * deny-and-hold / retry machinery admits a held train automatically once a slot
 * frees.
 *
 * The interior (which slot, the single-lead shuffling, coupling/decoupling) is
 * the device's own business and is modelled here at the wire-faithful level:
 * the device emits real `zone_state_changed` occupancy facts. When a train
 * leaves with rearranged carriages the yard reconciles its length via the
 * ADR-023 `core.reports_length` seam (`reportTrainLength`) — the "yard swallows
 * a train of length X and emits one of length Y" headline.
 */
export class VirtualRailyard {
  /** One entry per slot: an occupant label, or null if free. */
  private readonly slots: (string | null)[];
  /**
   * The yard's spare cut — the wagons it holds ready to couple onto the next
   * visiting train (e.g. the two purple carriages it starts with). FIFO: when a
   * train is serviced its leading pair is dropped here and becomes the spares
   * for the *next* visitor, so a wagon migrates from train to train across
   * laps. Holds one yard slot while non-empty.
   */
  private spares: VirtualCarriage[] = [];
  /** Trains serviced since their current arrival (so we swap once per visit),
   *  mapped to the slot they occupy while inside; cleared when they depart. */
  private readonly servicing = new Map<string, number>();
  /** Consecutive ticks a not-yet-serviced train has been parked at the throat.
   *  We wait a short dwell before acting (see DWELL_TICKS). */
  private readonly parkedTicks = new Map<string, number>();

  constructor(
    private readonly device_id: string,
    private readonly zone_marker_id: string,
    capacity: number,
    private readonly emit: (e: RailyardEvent) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new Error(`VirtualRailyard capacity must be a non-negative integer, got ${capacity}`);
    }
    this.slots = new Array<string | null>(capacity).fill(null);
  }

  /** The marker this yard gates (its throat). */
  get throatMarkerId(): string {
    return this.zone_marker_id;
  }

  /** The wagons the yard currently holds spare (read-only view, for the UI). */
  getSpares(): ReadonlyArray<VirtualCarriage> {
    return this.spares;
  }

  /**
   * Load the yard's initial spare cut (e.g. the two purple carriages it starts
   * with). Occupies a slot while non-empty and re-announces occupancy.
   */
  loadSpares(carriages: ReadonlyArray<VirtualCarriage>): void {
    this.spares = [...carriages];
    if (this.spares.length > 0 && this.slots.indexOf('spares') === -1) {
      const idx = this.slots.indexOf(null);
      if (idx !== -1) this.slots[idx] = 'spares';
    }
    this.announce();
  }

  /**
   * Swap a visiting train's leading pair for the yard's spares (ADR-026/027 —
   * the opaque-interior rearrange). The train's front `SWAP_PAIR_SIZE` wagons
   * are dropped into the yard and become the next spares; the previous spares
   * couple onto the front of the train. Pure consist mutation — nothing crosses
   * the wire (carriages are invisible to core, ADR-016). A no-op if the train
   * has fewer than `SWAP_PAIR_SIZE` wagons.
   */
  swapLeadingPair(train: VirtualTrain): void {
    const consist = train.getConsist();
    if (consist.length < SWAP_PAIR_SIZE) return;
    const leaving = consist.slice(0, SWAP_PAIR_SIZE);
    const rest = consist.slice(SWAP_PAIR_SIZE);
    const incoming = this.spares.slice(0, SWAP_PAIR_SIZE);
    train.setConsist([...incoming, ...rest]);
    this.spares = [...leaving];
  }

  /**
   * Service trains that have pulled into the throat and suspended there
   * (ADR-027). For each train newly parked at the throat: swap its leading pair
   * for the spares, occupy a slot, and release it back to core authority (the
   * scheduler reclaims it; the operator's next leg drives it out). A train
   * already serviced this visit is skipped until it departs; one that has left
   * the throat frees its slot and re-arms for its next lap.
   *
   * `entries` is the live (train_id, train) set — supplied by `Simulation` each
   * tick. The yard only ever *reads* train state and rearranges carriages; it
   * never drives a train across the throat (that stays core-cleared, ADR-027).
   */
  service(entries: Iterable<readonly [string, VirtualTrain]>): void {
    const present = new Set<string>();
    for (const [trainId, train] of entries) {
      present.add(trainId);
      this.serviceTrain(trainId, train);
    }
    // A train that vanished entirely (despawned) also frees its slot.
    for (const trainId of [...this.servicing.keys()]) {
      if (!present.has(trainId)) this.departTrain(trainId);
    }
  }

  /** Service one train: dwell while it parks, swap+release once, free on exit. */
  private serviceTrain(trainId: string, train: VirtualTrain): void {
    const parked = train.isParkedAt(this.zone_marker_id);
    if (this.servicing.has(trainId)) {
      if (!parked) this.departTrain(trainId); // it has pulled out — re-arm
      return;
    }
    if (!parked) {
      this.parkedTicks.delete(trainId);
      return;
    }
    const ticks = (this.parkedTicks.get(trainId) ?? 0) + 1;
    if (ticks < DWELL_TICKS) {
      this.parkedTicks.set(trainId, ticks);
      return;
    }
    // Dwell satisfied: rearrange the consist and hand the train back to core.
    this.parkedTicks.delete(trainId);
    this.swapLeadingPair(train);
    this.servicing.set(trainId, this.occupy(trainId));
    this.releaseTrain(trainId);
  }

  /** Free the slot a departed/vanished train held and re-arm it for next lap. */
  private departTrain(trainId: string): void {
    const slot = this.servicing.get(trainId);
    this.servicing.delete(trainId);
    this.parkedTicks.delete(trainId);
    if (slot !== undefined && slot >= 0) this.vacate(slot);
  }

  get capacity(): number {
    return this.slots.length;
  }

  get occupancy(): number {
    return this.slots.reduce((n, slot) => (slot === null ? n : n + 1), 0);
  }

  /**
   * Registration: announce the `core.gates_zone` capability, then publish the
   * zone's initial capacity + occupancy so the scheduler knows the gate exists.
   */
  register(): void {
    this.emit({
      event_type: 'device_registered',
      device_id: this.device_id,
      // gates_zone to arbitrate admission; reports_length to reconcile a train's
      // length on its way out (ADR-023) — the railyard rearranges carriages.
      payload: { capabilities: ['core.gates_zone', 'core.reports_length'] },
    });
    this.announce();
  }

  /**
   * Reconcile a train's length as it leaves the yard with rearranged carriages
   * (ADR-023). The scheduler honours this because the railyard declared
   * `core.reports_length`; the train need not be aware. `length_mm` must be a
   * positive number of millimetres.
   */
  reportTrainLength(train_id: string, length_mm: number): void {
    this.emit({
      event_type: 'train_length_changed',
      device_id: this.device_id,
      payload: { train_id, train_length_mm: length_mm },
    });
  }

  /**
   * Release a train the yard holds inside back to core authority (ADR-027). The
   * scheduler reclaims it at the throat; it departs only under ordinary
   * clearance — the yard never drives a train across the throat itself. Pair with
   * `vacate()` to free the slot it occupied.
   */
  releaseTrain(train_id: string): void {
    this.emit({
      event_type: 'zone_train_released',
      device_id: this.device_id,
      payload: { zone_marker_id: this.zone_marker_id, train_id },
    });
  }

  /**
   * Fill the next free slot with an occupant label (a parked consist, or a cut
   * of carriages — the label is the device's private business). Emits the new
   * occupancy. Returns the slot index, or -1 if the yard is already full.
   */
  occupy(label = 'consist'): number {
    const idx = this.slots.indexOf(null);
    if (idx === -1) return -1;
    this.slots[idx] = label;
    this.announce();
    return idx;
  }

  /**
   * Free a slot — by index, or the first occupied slot if none is given —
   * modelling a consist (or a cut of carriages) leaving the yard. Emits the new
   * occupancy. A no-op if the target slot is already free or out of range.
   */
  vacate(slot?: number): void {
    const idx = slot ?? this.slots.findIndex((s) => s !== null);
    if (idx < 0 || idx >= this.slots.length || this.slots[idx] == null) return;
    this.slots[idx] = null;
    this.announce();
  }

  /** Fill every remaining slot — convenience for "the yard is full". */
  fillToCapacity(): void {
    let changed = false;
    for (let i = 0; i < this.slots.length; i += 1) {
      if (this.slots[i] === null) {
        this.slots[i] = 'consist';
        changed = true;
      }
    }
    if (changed) this.announce();
  }

  /** Re-publish the current zone capacity + occupancy as `zone_state_changed`. */
  private announce(): void {
    this.emit({
      event_type: 'zone_state_changed',
      device_id: this.device_id,
      payload: {
        zone_marker_id: this.zone_marker_id,
        capacity: this.capacity,
        occupancy: this.occupancy,
      },
    });
  }
}
