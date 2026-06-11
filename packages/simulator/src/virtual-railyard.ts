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

/* The interior choreography (ADR-029). The yard drives the SELF-PROPELLED train
   along its REAL interior rails (the toy-table's spine + ladder legs + slots) —
   no floating across the body. Phases, each a single physical move the toy-table
   animates by following the matching centre-line path:

     enter        the train drives in off the throat onto a free slot;
     decouple     it sits while the CRANE lifts its leading cut off (the crane
                  only ever handles CUTS OF CARRIAGES, never the loco/train);
     cross-pull   it pulls back out onto the spine lead;
     cross-set    it drives into the spares slot and the spares couple on;
     inspect      it sits while the crane's camera reads it correct;
     release-out  it drives back to the throat to be handed to core.

   The train STAYS in the slot it ends up in (no return-to-neutral). The device
   owns the logic + consist; the toy-table owns all geometry (which centre-line,
   where the crane and cuts render) — this file only emits phase + progress +
   slot choices, kept geometry-free. The slot lane values mirror the UI's
   RAILYARD_SLOT_YS so the train lands ON a drawn slot. */
/** The free slot the train enters, and the slot holding the yard's spares (where
 *  the UI also draws the spare cut). Mirrors RAILYARD_SLOT_YS. */
const ENTRY_SLOT_Y = 132;
const SPARES_SLOT_Y = -84;
/* Ticks each phase takes: drive phases roll the train along their path; crane
   phases are the lift/read dwell. Tick-based like the rest of the yard's timing
   (deterministic, no dt threading). */
const DRIVE_TICKS = 22;
const DECOUPLE_TICKS = 16;
const INSPECT_TICKS = 14;
/** Progress within `decouple` at which the crane has lifted the cut, and within
 *  `cross-set` at which the train has bumped and coupled the spares. */
const DECOUPLE_LIFT_AT = 0.5;
const COUPLE_AT = 0.88;

/** The phases of the single-lead interior maneuver (ADR-026: one mover inside at
 *  a time), in order. See the file-head comment for what each animates. */
type ShuntPhase = 'enter' | 'decouple' | 'cross-pull' | 'cross-set' | 'inspect' | 'release-out';

/** The single-lead interior maneuver in progress. Geometry-free: just the phase,
 *  its 0..1 progress, the chosen slots, and the consist bookkeeping. */
interface Shunt {
  readonly trainId: string;
  readonly train: VirtualTrain;
  phase: ShuntPhase;
  /** Progress through the current phase, 0..1. */
  progress: number;
  /** Whether this visit swaps a cut at all (needs a full leading cut + spares). */
  swapping: boolean;
  /** The leading cut the crane has lifted off (held until the train picks up the
   *  spares, then it becomes the next visitor's spares). */
  dropped: VirtualCarriage[];
  decoupled: boolean;
  coupled: boolean;
}

/** Ticks the given phase runs for (crane phases dwell; drives roll). */
function phaseTicks(phase: ShuntPhase): number {
  if (phase === 'decouple') return DECOUPLE_TICKS;
  if (phase === 'inspect') return INSPECT_TICKS;
  return DRIVE_TICKS;
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
  /** The interior maneuver currently running, or null when the lead is free.
   *  Single-lead (ADR-026): at most one train moves inside at a time; others
   *  wait suspended at the throat. */
  private activeShunt: Shunt | null = null;

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
    const present = new Map<string, VirtualTrain>();
    for (const [trainId, train] of entries) present.set(trainId, train);

    this.tickActiveShunt(present); // advance the maneuver in progress (single-lead)
    for (const [trainId, train] of present) this.considerTrain(trainId, train);
    // A train that vanished entirely (despawned) also frees its slot.
    for (const trainId of [...this.servicing.keys()]) {
      if (!present.has(trainId)) this.departTrain(trainId);
    }
  }

  /** Step the single-lead maneuver one tick, or drop it if its train vanished. */
  private tickActiveShunt(present: ReadonlyMap<string, VirtualTrain>): void {
    if (this.activeShunt === null) return;
    if (!present.has(this.activeShunt.trainId)) {
      this.activeShunt = null;
      return;
    }
    this.advanceShunt(this.activeShunt);
  }

  /** Per-train bookkeeping: free a serviced train's slot when it pulls out, and
   *  start the next maneuver once a freshly-parked train has dwelt and the lead
   *  is free. */
  private considerTrain(trainId: string, train: VirtualTrain): void {
    const parked = train.isParkedAt(this.zone_marker_id);
    if (this.servicing.has(trainId)) {
      if (!parked) this.departTrain(trainId);
      return;
    }
    if (this.activeShunt?.trainId === trainId) return; // already moving inside
    if (!parked) {
      this.parkedTicks.delete(trainId);
      return;
    }
    const ticks = (this.parkedTicks.get(trainId) ?? 0) + 1;
    this.parkedTicks.set(trainId, ticks);
    if (ticks >= DWELL_TICKS && this.activeShunt === null) this.beginShunt(trainId, train);
  }

  /** Start the interior maneuver for a train newly parked at the throat. The
   *  yard decides up front whether this visit needs a carriage swap at all (it
   *  does when the train has a full leading cut to give and the yard holds spares
   *  to hand back); a train with nothing to swap still enters and is inspected,
   *  but the crane never lifts a cut. */
  private beginShunt(trainId: string, train: VirtualTrain): void {
    this.parkedTicks.delete(trainId);
    const swapping = train.getConsist().length >= SWAP_PAIR_SIZE && this.spares.length > 0;
    this.activeShunt = {
      trainId,
      train,
      phase: 'enter',
      progress: 0,
      swapping,
      dropped: [],
      decoupled: false,
      coupled: false,
    };
  }

  /**
   * Advance one tick of the single-lead interior maneuver: roll the current
   * phase's progress, fire its consist milestone (the crane lifting the leading
   * cut mid-`decouple`; the spares coupling on near the end of `cross-set`), and
   * step to the next phase when the current one completes.
   */
  private advanceShunt(shunt: Shunt): void {
    shunt.progress = Math.min(1, shunt.progress + 1 / phaseTicks(shunt.phase));
    if (shunt.phase === 'decouple' && !shunt.decoupled && shunt.progress >= DECOUPLE_LIFT_AT) {
      this.decoupleLeadingCut(shunt);
      shunt.decoupled = true;
    }
    if (shunt.phase === 'cross-set' && !shunt.coupled && shunt.progress >= COUPLE_AT) {
      this.coupleSpares(shunt);
      shunt.coupled = true;
    }
    if (shunt.progress >= 1) this.nextPhase(shunt);
  }

  /** Step to the next phase (resetting progress), or finish the maneuver. A
   *  no-swap visit skips the crane/cross phases: it enters, is inspected, leaves. */
  private nextPhase(shunt: Shunt): void {
    shunt.progress = 0;
    switch (shunt.phase) {
      case 'enter':
        shunt.phase = shunt.swapping ? 'decouple' : 'inspect';
        return;
      case 'decouple':
        shunt.phase = 'cross-pull';
        return;
      case 'cross-pull':
        shunt.phase = 'cross-set';
        return;
      case 'cross-set':
        shunt.phase = 'inspect';
        return;
      case 'inspect':
        shunt.phase = 'release-out';
        return;
      case 'release-out':
        this.completeShunt(shunt);
        return;
    }
  }

  /** Crane lifts the train's leading cut off; it is held by the crane until it
   *  becomes the yard's spares at the couple step (the spares already hold a
   *  slot, so no extra slot is taken here). */
  private decoupleLeadingCut(shunt: Shunt): void {
    const consist = shunt.train.getConsist();
    if (consist.length < SWAP_PAIR_SIZE) return;
    shunt.dropped = consist.slice(0, SWAP_PAIR_SIZE);
    shunt.train.setConsist(consist.slice(SWAP_PAIR_SIZE));
  }

  /** The waiting spare cut collides with the reversing train and auto-couples
   *  onto its front; the cut just dropped becomes the spares for the next visitor
   *  (the FIFO migration). */
  private coupleSpares(shunt: Shunt): void {
    const incoming = this.spares.slice(0, SWAP_PAIR_SIZE);
    shunt.train.setConsist([...incoming, ...shunt.train.getConsist()]);
    this.spares = [...shunt.dropped];
  }

  /** Finish the maneuver: take the train's slot, hand it back to core (it
   *  departs under ordinary clearance, ADR-027), and free the lead. */
  private completeShunt(shunt: Shunt): void {
    this.servicing.set(shunt.trainId, this.occupy(shunt.trainId));
    this.releaseTrain(shunt.trainId);
    this.activeShunt = null;
  }

  /**
   * The interior maneuver state for the toy-table to render — geometry-free. The
   * UI maps `phase` + `progress` onto the actual yard centre-line for that move
   * (so the train follows real rails), parks/works the crane per phase, and draws
   * the lifted cut. `entrySlotY`/`sparesSlotY` are the chosen slots (local-frame
   * lane mm, matching RAILYARD_SLOT_YS); `droppedCutIds` is the cut the crane is
   * currently holding (empty until the crane lifts it, cleared once it becomes
   * the spares); `trailOffset` is how many wagons are missing from the front
   * while a cut is lifted, so the UI can hold the remaining rake in place instead
   * of letting it jump forward. Null when no maneuver is running. UI-only.
   */
  getInteriorState(): {
    trainId: string;
    phase: ShuntPhase;
    progress: number;
    swapping: boolean;
    entrySlotY: number;
    sparesSlotY: number;
    droppedCutIds: string[];
    trailOffset: number;
  } | null {
    const shunt = this.activeShunt;
    if (shunt === null) return null;
    const cutLifted = shunt.decoupled && !shunt.coupled;
    return {
      trainId: shunt.trainId,
      phase: shunt.phase,
      progress: shunt.progress,
      swapping: shunt.swapping,
      entrySlotY: ENTRY_SLOT_Y,
      sparesSlotY: SPARES_SLOT_Y,
      droppedCutIds: cutLifted ? shunt.dropped.map((c) => c.id) : [],
      trailOffset: cutLifted ? SWAP_PAIR_SIZE : 0,
    };
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
