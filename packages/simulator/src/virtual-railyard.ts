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

/* The interior choreography (ADR-029). A serviced train is driven, in sim ticks,
   through the yard's private 2D interior: it pulls off the throat into a free
   slot to enter, the crane decides whether to decouple and lifts its leading cut
   off, the train pulls forward then REVERSES across into the spares slot where
   the waiting cut collides and magnetically auto-couples (simulator-only), it
   returns to a neutral slot, and the crane's camera reads it correct before the
   yard releases it. All distances are the device's private interior geometry in
   its local frame (depth = mm into the yard from the throat along its spine;
   lane = mm laterally across the slots); the toy-table renders the train and the
   crane at these poses. The lane values mirror the UI's RAILYARD_SLOT_YS so a
   moving train lands ON a drawn slot. */
/* Lateral lanes (mm) the interior choreography uses — three of the yard's six
   drawn slots: an entry slot the train first parks in (a free lower slot), the
   spares slot it reverses across into to pick up (an upper slot, where the yard
   draws its waiting cut), and the centre spine it returns to (neutral). The
   spares lane matches where the toy-table renders the yard's spare wagons so the
   reverse-into-them reads as a real collision. */
const ENTRY_LANE_MM = 84;
const SPARES_LANE_MM = -84;
const NEUTRAL_LANE_MM = 0;
/* Depths (mm from the throat): a parked slot depth, and the deeper pull-forward
   the train makes before reversing across into the spares slot. */
const SLOT_DEPTH_MM = 150;
const FORWARD_DEPTH_MM = 235;
/* How far the train moves through the interior per tick (deterministic,
   tick-based like the rest of the yard's timing — no dt threading). */
const INTERIOR_STEP_MM = 12;
/* Ticks the crane spends working at each couple/decouple, and the ticks its
   camera spends reading the train before the yard trusts the consist for
   release. */
const CRANE_TICKS = 6;
const INSPECT_TICKS = 5;

/** One interior step toward a target delta, capped at INTERIOR_STEP_MM (so the
 *  crane creeps rather than teleports). @pure */
function clampStep(delta: number): number {
  if (Math.abs(delta) <= INTERIOR_STEP_MM) return delta;
  return Math.sign(delta) * INTERIOR_STEP_MM;
}

/** The phases of the single-lead interior maneuver (ADR-026: one mover inside at
 *  a time), in order. `enter` parks the train off the throat into a free slot;
 *  `decouple` is the crane deciding-and-lifting its leading cut into a drop slot;
 *  `pull-forward` then `reverse-pickup` is the forward-and-back move that reverses
 *  the train across into the spares slot, where the waiting cut collides and
 *  auto-couples; `return` neutralises it in a slot; `inspect` is the crane camera
 *  reading it correct; `release` hands it back to core. */
type ShuntStep =
  | 'enter'
  | 'decouple'
  | 'pull-forward'
  | 'reverse-pickup'
  | 'return'
  | 'inspect'
  | 'release';

/** The single-lead interior maneuver in progress. Tracks the train's interior
 *  pose (depth + lane) and the crane's, so both animate truthfully to the work. */
interface Shunt {
  readonly trainId: string;
  readonly train: VirtualTrain;
  step: ShuntStep;
  /** Train pose: depth into the yard (mm from throat) and lateral lane (mm). */
  depthMm: number;
  laneMm: number;
  /** Crane pose: it travels over whatever it is working (the cut, then the
   *  train). Lags toward the train's working point each tick. */
  craneDepthMm: number;
  craneLaneMm: number;
  /** Ticks left in the current crane action (couple/decouple) or camera read. */
  craneTicks: number;
  /** Whether the yard decided this visit needs a decouple/recouple at all. */
  swapping: boolean;
  /** The cut the crane has lifted off this train (held until it becomes the
   *  next visitor's spares). */
  dropped: VirtualCarriage[];
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
      step: 'enter',
      depthMm: 0,
      laneMm: 0,
      craneDepthMm: 0,
      craneLaneMm: 0,
      craneTicks: 0,
      swapping,
      dropped: [],
    };
  }

  /**
   * Advance one tick of the single-lead interior maneuver (the 5-step
   * choreography): the train pulls off the throat into a free slot to ENTER, the
   * crane DECOUPLEs its leading cut into a drop slot, the train pulls FORWARD then
   * REVERSEs across into the spares slot where the waiting cut collides and
   * auto-couples (PICKUP), it RETURNs to a neutral slot, the crane camera INSPECTs
   * it, then the yard RELEASEs it. A no-swap visit skips straight from enter to
   * inspect (it still officially enters and is read).
   */
  private advanceShunt(shunt: Shunt): void {
    this.creepCrane(shunt);
    switch (shunt.step) {
      case 'enter':
        // Pull off the throat into the entry slot; a no-swap visit is read and
        // released without the crane ever lifting a cut.
        this.driveStep(
          shunt,
          SLOT_DEPTH_MM,
          ENTRY_LANE_MM,
          shunt.swapping ? 'decouple' : 'inspect',
        );
        return;
      case 'decouple':
        if (this.craneWorking(shunt)) {
          this.decoupleLeadingCut(shunt);
          shunt.step = 'pull-forward';
        }
        return;
      case 'pull-forward':
        this.driveStep(shunt, FORWARD_DEPTH_MM, ENTRY_LANE_MM, 'reverse-pickup');
        return;
      case 'reverse-pickup':
        // Back across into the spares slot; on contact the waiting cut collides
        // and magnetically auto-couples (simulator-only).
        if (this.driveTo(shunt, SLOT_DEPTH_MM, SPARES_LANE_MM)) {
          this.coupleSpares(shunt);
          shunt.step = 'return';
        }
        return;
      case 'return':
        this.driveStep(shunt, SLOT_DEPTH_MM, NEUTRAL_LANE_MM, 'inspect');
        return;
      case 'inspect':
        // The crane camera reads the train; once it has dwelt over it the yard
        // trusts the consist and releases.
        if (this.craneWorking(shunt, INSPECT_TICKS)) shunt.step = 'release';
        return;
      case 'release':
        this.completeShunt(shunt);
        return;
    }
  }

  /** Drive toward a (depth, lane) target; advance to `next` once arrived. */
  private driveStep(shunt: Shunt, depthMm: number, laneMm: number, next: ShuntStep): void {
    if (this.driveTo(shunt, depthMm, laneMm)) shunt.step = next;
  }

  /** Drift the crane one step toward the train's working point each tick, so the
   *  gantry visibly follows the action (over the cut while decoupling, over the
   *  train otherwise) rather than teleporting. */
  private creepCrane(shunt: Shunt): void {
    const targetDepth = shunt.depthMm;
    const targetLane = shunt.step === 'decouple' ? ENTRY_LANE_MM : shunt.laneMm;
    shunt.craneDepthMm += clampStep(targetDepth - shunt.craneDepthMm);
    shunt.craneLaneMm += clampStep(targetLane - shunt.craneLaneMm);
  }

  /** Move the train toward the (depth, lane) target by one step along the
   *  straight line to it; true once it arrives. */
  private driveTo(shunt: Shunt, depthMm: number, laneMm: number): boolean {
    const dd = depthMm - shunt.depthMm;
    const dl = laneMm - shunt.laneMm;
    const dist = Math.hypot(dd, dl);
    if (dist <= INTERIOR_STEP_MM) {
      shunt.depthMm = depthMm;
      shunt.laneMm = laneMm;
      return true;
    }
    shunt.depthMm += (dd / dist) * INTERIOR_STEP_MM;
    shunt.laneMm += (dl / dist) * INTERIOR_STEP_MM;
    return false;
  }

  /** Count down a crane action; true on the tick it completes. */
  private craneWorking(shunt: Shunt, ticks: number = CRANE_TICKS): boolean {
    if (shunt.craneTicks === 0) shunt.craneTicks = ticks;
    shunt.craneTicks -= 1;
    return shunt.craneTicks === 0;
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
   * The interior pose for the toy-table to render: the train currently being
   * shunted (its interior depth + lane, both in the yard's local mm frame), the
   * crane's pose (which follows the work), and the phase. `craneWorking` is true
   * while the crane is lifting a cut or its camera is reading the train.
   * `reversing` is true on the back-across-into-spares move so the UI can flip
   * the rake. Null when the lead is idle. UI-only.
   */
  getInteriorState(): {
    trainId: string;
    step: ShuntStep;
    depthMm: number;
    laneMm: number;
    craneDepthMm: number;
    craneLaneMm: number;
    craneWorking: boolean;
    reversing: boolean;
    /** Legacy 0..1 depth, kept for callers that only want the pull-in fraction. */
    depthFraction: number;
  } | null {
    const shunt = this.activeShunt;
    if (shunt === null) return null;
    return {
      trainId: shunt.trainId,
      step: shunt.step,
      depthMm: shunt.depthMm,
      laneMm: shunt.laneMm,
      craneDepthMm: shunt.craneDepthMm,
      craneLaneMm: shunt.craneLaneMm,
      craneWorking: shunt.step === 'decouple' || shunt.step === 'inspect',
      reversing: shunt.step === 'reverse-pickup',
      depthFraction: Math.min(1, shunt.depthMm / FORWARD_DEPTH_MM),
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
