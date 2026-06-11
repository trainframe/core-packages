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
/** The two slots the demo's single-lead choreography alternates between: a train
 *  enters whichever is FREE and reverses into whichever holds the spares; on the
 *  way out it has shed its cut into the entry slot, so the spares slot rotates to
 *  the entry slot next visit (the touring swap). Both sit one rank off-centre on
 *  opposite sides of the spine — far enough off the lead to read, near enough the
 *  centre that the headshunt clears them. Mirror RAILYARD_SLOT_YS. */
const SLOT_A = 84;
const SLOT_B = -84;
/* Ticks each phase takes, tuned so the train moves at a roughly CONSTANT speed
   (counts ∝ each path's rough length, so no phase races) and the crane works
   SLOWLY (long dwells — a fast crane read as wrong). Combined with the eased
   progress below, the train accelerates off each stop and decelerates back to
   rest at the slot ends / reversals. Tick-based, deterministic. */
const PHASE_TICKS: Record<ShuntPhase, number> = {
  'lead-out': 30,
  enter: 26,
  decouple: 90,
  'pull-clear': 26,
  'back-to-spares': 30,
  settle: 12,
  inspect: 64,
  'exit-pull': 26,
  'exit-home': 30,
};
/** Progress within `decouple` at which the crane has split the coupling (the rear
 *  cut sheds), and within `back-to-spares` at which the train has backed onto the
 *  spares and they couple. */
const DECOUPLE_SPLIT_AT = 0.55;
const COUPLE_AT = 0.92;

/** The phases of the single-lead interior maneuver (ADR-026), in order. See the
 *  file-head comment + docs/spec/railyard-shunting-choreography.md. */
type ShuntPhase =
  | 'lead-out'
  | 'enter'
  | 'decouple'
  | 'pull-clear'
  | 'back-to-spares'
  | 'settle'
  | 'inspect'
  | 'exit-pull'
  | 'exit-home';

/** The single-lead interior maneuver in progress. Geometry-free: the phase, its
 *  0..1 progress, the slots it chose, and the consist bookkeeping. */
interface Shunt {
  readonly trainId: string;
  readonly train: VirtualTrain;
  /** The free slot the train entered, and the slot the spares sit in. Fixed for
   *  the whole maneuver (the device's persistent spares slot only rotates once
   *  the maneuver completes). */
  readonly entrySlotY: number;
  readonly sparesSlotY: number;
  phase: ShuntPhase;
  /** Progress through the current phase, 0..1. */
  progress: number;
  /** Whether this visit swaps a cut at all (needs a full rear cut + spares). */
  swapping: boolean;
  /** The rear cut the train sheds (parked in the entry slot; becomes the next
   *  visitor's spares once this maneuver completes). */
  dropped: VirtualCarriage[];
  decoupled: boolean;
  coupled: boolean;
}

/** Ticks the given phase runs for. */
function phaseTicks(phase: ShuntPhase): number {
  return PHASE_TICKS[phase];
}

/** Smoothstep easing (0→1) so a phase accelerates off its start and decelerates
 *  to a stop at its end — the train eases to rest at slot ends / reversals rather
 *  than snapping. @pure */
function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
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
  /** Which slot the spare cut currently rests in (local-frame lane mm). Rotates
   *  to the entry slot each time a train sheds there (the touring swap). */
  private sparesSlotY: number = SLOT_B;
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
    // Enter whichever of the two slots the spares are NOT in (a free slot). A
    // no-swap visit just enters its slot and leaves from it, so its "spares slot"
    // is that same entry slot.
    const entrySlotY = this.sparesSlotY === SLOT_A ? SLOT_B : SLOT_A;
    this.activeShunt = {
      trainId,
      train,
      entrySlotY,
      sparesSlotY: swapping ? this.sparesSlotY : entrySlotY,
      phase: 'lead-out',
      progress: 0,
      swapping,
      dropped: [],
      decoupled: false,
      coupled: false,
    };
  }

  /**
   * Advance one tick of the maneuver: roll the current phase's progress, fire its
   * consist milestone (the crane SPLITTING the coupling mid-`decouple` so the rear
   * cut sheds; the spares COUPLING on near the end of `back-to-spares`), and step
   * to the next phase when the current one completes.
   */
  private advanceShunt(shunt: Shunt): void {
    shunt.progress = Math.min(1, shunt.progress + 1 / phaseTicks(shunt.phase));
    if (shunt.phase === 'decouple' && !shunt.decoupled && shunt.progress >= DECOUPLE_SPLIT_AT) {
      this.shedRearCut(shunt);
      shunt.decoupled = true;
    }
    if (shunt.phase === 'back-to-spares' && !shunt.coupled && shunt.progress >= COUPLE_AT) {
      this.coupleSpares(shunt);
      shunt.coupled = true;
    }
    if (shunt.progress >= 1) this.nextPhase(shunt);
  }

  /** Step to the next phase (resetting progress), or finish the maneuver. A
   *  no-swap visit skips the swap phases: it enters, is inspected, and leaves. */
  private nextPhase(shunt: Shunt): void {
    shunt.progress = 0;
    switch (shunt.phase) {
      case 'lead-out':
        shunt.phase = 'enter';
        return;
      case 'enter':
        shunt.phase = shunt.swapping ? 'decouple' : 'inspect';
        return;
      case 'decouple':
        shunt.phase = 'pull-clear';
        return;
      case 'pull-clear':
        shunt.phase = 'back-to-spares';
        return;
      case 'back-to-spares':
        shunt.phase = 'settle';
        return;
      case 'settle':
        shunt.phase = 'inspect';
        return;
      case 'inspect':
        shunt.phase = 'exit-pull';
        return;
      case 'exit-pull':
        shunt.phase = 'exit-home';
        return;
      case 'exit-home':
        this.completeShunt(shunt);
        return;
    }
  }

  /** The crane splits the coupling between the kept front of the rake and its rear
   *  cut; the train will pull forward and leave that cut parked in the entry slot.
   *  Pure consist mutation — the cut just stays where it was. */
  private shedRearCut(shunt: Shunt): void {
    const consist = shunt.train.getConsist();
    if (consist.length < SWAP_PAIR_SIZE) return;
    shunt.dropped = consist.slice(-SWAP_PAIR_SIZE);
    shunt.train.setConsist(consist.slice(0, -SWAP_PAIR_SIZE));
  }

  /** The train has backed onto the spares; they auto-couple onto its rear. (The
   *  shed cut becomes the next visitor's spares only once the maneuver completes,
   *  so the spare slot doesn't rotate mid-maneuver.) */
  private coupleSpares(shunt: Shunt): void {
    const incoming = this.spares.slice(0, SWAP_PAIR_SIZE);
    shunt.train.setConsist([...shunt.train.getConsist(), ...incoming]);
  }

  /** Finish the maneuver: the shed cut becomes the new spares, sitting in the
   *  entry slot (so the spares slot rotates there — the touring swap); take the
   *  train's slot, hand it back to core (ADR-027), and free the lead. */
  private completeShunt(shunt: Shunt): void {
    if (shunt.coupled) {
      this.spares = [...shunt.dropped];
      this.sparesSlotY = shunt.entrySlotY;
    }
    this.servicing.set(shunt.trainId, this.occupy(shunt.trainId));
    this.releaseTrain(shunt.trainId);
    this.activeShunt = null;
  }

  /**
   * The interior maneuver state for the toy-table to render — geometry-free. The
   * UI maps `phase` + `progress` onto the actual yard centre-line for that move
   * (so the train follows real rails), positions the decoupler crane, and draws
   * the two cuts. `shedCutIds` is the rear cut left parked in the entry slot (from
   * the split until the maneuver ends); `sparesCutIds` is the spare cut waiting in
   * the spares slot (until the train couples it on). Null when idle. UI-only.
   */
  getInteriorState(): {
    trainId: string;
    phase: ShuntPhase;
    progress: number;
    swapping: boolean;
    entrySlotY: number;
    sparesSlotY: number;
    shedCutIds: string[];
    sparesCutIds: string[];
  } | null {
    const shunt = this.activeShunt;
    if (shunt === null) return null;
    return {
      trainId: shunt.trainId,
      phase: shunt.phase,
      // Eased for rendering (smooth accel/decel); the raw progress drives the
      // internal milestones above.
      progress: ease(shunt.progress),
      swapping: shunt.swapping,
      entrySlotY: shunt.entrySlotY,
      sparesSlotY: shunt.sparesSlotY,
      shedCutIds: shunt.decoupled ? shunt.dropped.map((c) => c.id) : [],
      sparesCutIds: shunt.coupled ? [] : this.spares.map((c) => c.id),
    };
  }

  /** Which slot the spare cut currently rests in (UI renders the resting spares
   *  there when no maneuver is running). */
  getSparesSlotY(): number {
    return this.sparesSlotY;
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
