interface RailyardEvent {
  event_type: string;
  device_id: string;
  payload: unknown;
}

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
