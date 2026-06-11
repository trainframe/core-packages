/**
 * The DEPOT / roundhouse as a portable zone controller (ADR-032, ADR-026/027,
 * ADR-030 §1, ADR-031). This is the first concrete TWO-LEVEL nested opaque zone:
 *
 *   - To CORE the depot is ONE opaque zone — a boundary throat, a capacity (its N
 *     stalls), and ONE rolled-up asserted occupancy (filled stalls / capacity).
 *     Core never sees the turntable, the stalls, or anything inside (ADR-026).
 *   - INSIDE, the depot orchestrates a central TURNTABLE (a capacity-1 zone). It
 *     OWNS the turntable's deck actuator and the visiting train's motor, and it
 *     decides when the deck may move / which stall it routes a loco onto. The
 *     turntable controller below is the inner device; the depot is "core-shaped"
 *     to it (ADR-032 §1 — report upward, never sideways to core).
 *
 * NESTING SEAM (ADR-031 + ADR-032, now BUILT): the depot is "core-shaped" to its
 * interior turntable via a real `PlatformProvider`. It owns a `ParentPlatform`
 * and hands the turntable child `platformFor(turntableChildId)` — a platform
 * provider INDISTINGUISHABLE from the real core. Through that seam the turntable
 * reports its occupancy UPWARD as a `zone_state_changed` (capacity-1: 0 = deck
 * free, 1 = deck busy) and the depot answers clearance DOWNWARD as
 * `grant_clearance` / `revoke_clearance` — never sideways to core (ADR-032 §1).
 * The depot folds the child's asserted occupancy into its OWN single rolled-up
 * occupancy (ADR-032 §2), which is the one number core sees for the whole opaque
 * zone. The turntable cannot tell its provider is the depot, not the broker —
 * that is the whole point.
 *
 * This is ADDITIVE: the depot still also owns the `TurntableActuator` directly
 * and drives it through the working loop below (the deck physics is a WORLD
 * actuator, ADR-030; the platform seam is the CORE link, ADR-031 — the two
 * families are orthogonal). The seam mirrors the deck's busy/free truth onto the
 * core link so the nesting is honest end to end.
 *
 * Honest actuators throughout (ADR-031 §2): the controller emits INTENT (drive
 * the train; align the deck) and AWAITS the physical result (`arrived`,
 * `alignedExit`, a camera sighting). No animation, no reading of simulator ground
 * truth. The TURNTABLE SERIALISES the interior: only one loco may be on the deck
 * at a time, so a second arrival WAITS at the throat while the deck is busy —
 * exactly the single-mover discipline ADR-026 §4 bounds the interior with.
 *
 * One admission cycle:
 *
 *   idle      no loco aboard; if a loco waits at the throat AND a stall is free,
 *             admit it (board the deck). Otherwise hold (deck busy / depot full)
 *   board     align the deck to the ENTRY; once seated, drive the loco on; stop it
 *             when the camera sees it on the deck centre
 *   route     pick a FREE stall; command the deck to swing to it; await `arrived`
 *   park      deck seated on the stall → drive the loco off into the bay; once the
 *             camera sees it parked, mark the stall occupied and free the deck
 *   (back to idle, ready for the next visitor)
 *
 * Tick-driven over a virtual clock; pure (no DOM, no Date.now).
 */
import { type CoreCommand, type CoreEvent, PROTOCOL_VERSION } from '@trainframe/protocol';
import type { DepotLayout, DepotStall } from '../physics/depot.js';
import { stallSensePoint } from '../physics/depot.js';
import { ParentPlatform } from './parent-platform.js';
import type { PlatformProvider } from './platform-provider.js';
import type { TrainDevice } from './train-device.js';
import type { TurntableActuator } from './turntable-actuator.js';

/** A fixed envelope timestamp for the interior nesting seam. The depot is pure
 *  (no Date.now) and the seam is interior to the depot, so the exact instant is
 *  immaterial — it only has to be a well-formed ISO-8601 so the wire shape is
 *  valid if the seam were ever bridged out. */
const SEAM_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** Default interior ids for the nested turntable. UUIDs so the nesting seam
 *  carries structurally-valid wire shapes (they are INTERIOR to the depot and
 *  never seen by core — ADR-032). */
const DEPOT_TURNTABLE_ID = '0d0e0001-0000-4000-8000-000000000001';
const DEPOT_DECK_MARKER_ID = '0d0e0002-0000-4000-8000-000000000002';

/** What the camera reports beneath its footprint (same shape the yard/turntable
 *  use). The depot perceives the interior only through this — never ground truth. */
export interface Sighting {
  readonly occupied: boolean;
  readonly colour?: string | undefined;
}

/** A loco waiting at the depot throat to be admitted — the train device the depot
 *  will drive, plus the stall it should ultimately be routed onto (the depot's
 *  interior assignment; in the full system core only routes it TO the throat). */
export interface DepotArrival {
  readonly train: TrainDevice;
  /** The stall id to park it in. Must be one of the layout's stalls. */
  readonly stallId: string;
}

export interface DepotControllerDeps {
  readonly layout: DepotLayout;
  /** The INTERIOR turntable deck — owned and orchestrated by the depot (the
   *  nesting). The depot commands its intent and awaits its physical result; it is
   *  core-shaped to this actuator (ADR-032). */
  readonly deck: TurntableActuator;
  /** Look at world (x,y) and report what's beneath the footprint there. */
  readonly look: (x: number, y: number) => Sighting;
  /** The inner turntable's device id on the parent↔child platform seam. The
   *  depot is core for this child. A UUID so the seam carries valid wire shapes
   *  if ever bridged out. Defaults to a fixed interior id. */
  readonly turntableChildId?: string;
  /** The interior boundary marker the depot maps the turntable onto — INTERIOR to
   *  the depot, never seen by core (ADR-032). A UUID for the same reason. */
  readonly turntableZoneMarkerId?: string;
}

type Phase = 'idle' | 'board' | 'route' | 'park';

export class DepotController {
  private readonly d: DepotControllerDeps;
  /** Locos queued at the throat, FIFO — the depot admits one at a time. */
  private readonly queue: DepotArrival[] = [];
  /** Which stall ids currently hold a parked loco (the depot's private interior
   *  state — the basis for its single rolled-up occupancy). */
  private readonly occupied = new Set<string>();
  /** The loco currently being serviced through the interior (on or bound for the
   *  deck), or null when the deck is free. */
  private current: DepotArrival | null = null;
  private phase: Phase = 'idle';
  private timer = 0;
  /** Whether the single "go" for the park drive has been issued (we command once
   *  and then observe — re-asserting forward each tick would fight a deck that
   *  re-expressed the motor intent as it turned). */
  private parkCommanded = false;

  /** The parent side of the ADR-032 nesting seam: the depot IS the turntable
   *  child's core. The child is wired from `platformFor(childId)`; the depot
   *  observes its occupancy here and commands its clearance here. */
  private readonly child = new ParentPlatform();
  private readonly childId: string;
  private readonly zoneMarkerId: string;
  /** The deck-busy truth last mirrored onto the seam, so we only emit on change
   *  (the occupancy/clearance seam is edge-triggered, like every zone report).
   *  Starts `false`: the deck begins free, so a quiescent depot emits nothing. */
  private lastDeckBusy = false;
  /** Monotonic counter for deterministic seam-envelope ids (depot stays pure —
   *  no Date.now, no Math.random on this path). */
  private seamSeq = 0;

  constructor(deps: DepotControllerDeps) {
    this.d = deps;
    this.childId = deps.turntableChildId ?? DEPOT_TURNTABLE_ID;
    this.zoneMarkerId = deps.turntableZoneMarkerId ?? DEPOT_DECK_MARKER_ID;
  }

  /** The platform provider the INTERIOR turntable is wired from. To the turntable
   *  this is its core; in truth it is the depot (ADR-032 §1 — parent-as-core via
   *  the ADR-031 platform provider). The turntable controller cannot tell the
   *  difference between this and the real broker. */
  platformFor(childId: string = this.childId): PlatformProvider {
    return this.child.platformFor(childId);
  }

  /** Observe the turntable child's events, exactly as core would. The depot folds
   *  whatever occupancy the child asserts into its own rolled-up number (here the
   *  inner zone is capacity-1; a multi-stall child would roll up the same way). */
  onTurntableEvent(handler: (event: CoreEvent) => void): () => void {
    return this.child.onChildEvent(this.childId, handler);
  }

  /** Mirror the deck's busy/free truth onto the nesting seam: report the inner
   *  capacity-1 zone's occupancy UPWARD (as the turntable would) and answer
   *  clearance DOWNWARD. Edge-triggered — emit only when the truth flips. */
  private syncDeckSeam(): void {
    const busy = this.current !== null;
    if (busy === this.lastDeckBusy) return;
    this.lastDeckBusy = busy;
    /* The turntable reports its own occupancy up to its core (the depot). */
    this.child.platformFor(this.childId).publish(this.zoneEvent(busy ? 1 : 0));
    /* The depot, as core, answers the inner zone's clearance: withhold while the
     *  deck is busy (a second loco waits at the throat), grant when it frees. */
    this.child.command(this.childId, busy ? this.revoke() : this.grant());
  }

  /** A capacity-1 `zone_state_changed` for the inner turntable deck. */
  private zoneEvent(occupancy: number): CoreEvent {
    return {
      event_id: this.seamId(),
      device_id: this.childId,
      timestamp_device: SEAM_TIMESTAMP,
      event_type: 'zone_state_changed',
      protocol_version: PROTOCOL_VERSION,
      payload: { zone_marker_id: this.zoneMarkerId, capacity: 1, occupancy },
    };
  }

  private grant(): CoreCommand {
    return {
      command_id: this.seamId(),
      device_id: this.childId,
      timestamp_server: SEAM_TIMESTAMP,
      command_type: 'grant_clearance',
      protocol_version: PROTOCOL_VERSION,
      payload: { limit_marker_id: this.zoneMarkerId, reason: 'deck free' },
    };
  }

  private revoke(): CoreCommand {
    return {
      command_id: this.seamId(),
      device_id: this.childId,
      timestamp_server: SEAM_TIMESTAMP,
      command_type: 'revoke_clearance',
      payload: { reason: 'deck busy', immediate: true },
      protocol_version: PROTOCOL_VERSION,
    };
  }

  /** A deterministic, valid v4-UUID for a seam envelope — the counter encoded in
   *  the final field so the depot stays pure (no Math.random / Date.now) while the
   *  seam still carries structurally-valid wire shapes. */
  private seamId(): string {
    this.seamSeq += 1;
    const tail = this.seamSeq.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${tail}`;
  }

  /** Queue a loco at the throat. Admission is gated: it boards only when the deck
   *  is free AND its target stall is free (so the depot never exceeds capacity and
   *  never routes onto a busy deck). */
  arrive(arrival: DepotArrival): void {
    this.queue.push(arrival);
  }

  /** The depot's capacity — its number of stalls (what core sees as the zone
   *  capacity). */
  get capacity(): number {
    return this.d.layout.stalls.length;
  }

  /** The depot's SINGLE rolled-up occupancy: how many stalls are filled. This is
   *  the one number core sees for the whole opaque zone (ADR-032 §2 — the parent
   *  folds its interior into one asserted occupancy). */
  get occupancy(): number {
    return this.occupied.size;
  }

  /** Whether a particular stall currently holds a parked loco (interior detail,
   *  for tests / the view — never crosses to core). */
  isOccupied(stallId: string): boolean {
    return this.occupied.has(stallId);
  }

  /** Whether the interior turntable is currently BUSY (a loco is on or bound for
   *  the deck). A second arrival must wait while this is true — the deck is the
   *  serialised inner resource (ADR-026 §4, single-mover). */
  get deckBusy(): boolean {
    return this.current !== null;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  tick(dtS: number): void {
    this.timer += dtS;
    /* The interior turntable owns its own rotation physics; the depot, as its
     *  parent-core, only steps it (the WORLD-actuator side of the nesting). */
    this.d.deck.step(dtS);
    /* Mirror the deck's busy/free truth onto the ADR-031 platform seam: report the
     *  inner zone's occupancy up, answer its clearance down (the CORE-link side). */
    this.syncDeckSeam();
    switch (this.phase) {
      case 'idle':
        this.idle();
        break;
      case 'board':
        this.board();
        break;
      case 'route':
        this.route();
        break;
      case 'park':
        this.park();
        break;
    }
  }

  private to(phase: Phase): void {
    this.phase = phase;
    this.timer = 0;
  }

  private stall(id: string): DepotStall {
    const s = this.d.layout.stalls.find((x) => x.id === id);
    if (s === undefined) throw new Error(`depot: no stall ${id}`);
    return s;
  }

  /** Hold any queued loco at the throat (motor stopped) until the deck is free and
   *  its target stall is free, then admit ONE — board it onto the deck. While the
   *  deck is busy every waiting loco stays put: the turntable serialises the
   *  interior. */
  private idle(): void {
    /* Every waiting loco is held at the throat (clearance withheld = stopped). */
    for (const a of this.queue) a.train.stop();
    if (this.current !== null) return; // deck busy — serialised
    const next = this.queue.find((a) => !this.occupied.has(a.stallId));
    if (next === undefined) return; // nothing admissible (full, or all targets taken)
    this.queue.splice(this.queue.indexOf(next), 1);
    this.current = next;
    this.parkCommanded = false;
    this.to('board');
  }

  /** Align the deck to the ENTRY, then — once it is seated — drive the loco on and
   *  stop it on the deck centre (sensed, not assumed). */
  private board(): void {
    const cur = this.current;
    if (cur === null) return;
    this.d.deck.alignTo(this.d.layout.entryPosition);
    if (this.d.deck.alignedExit !== this.d.layout.entryPosition) {
      cur.train.stop(); // hold off a deck still swinging to the entry
      return;
    }
    if (this.d.look(this.d.layout.deckCentre.x, this.d.layout.deckCentre.y).occupied) {
      cur.train.stop();
      this.to('route');
      return;
    }
    cur.train.forward();
  }

  /** Command the deck to swing to the assigned FREE stall and AWAIT the physical
   *  swing. The loco's motion is withheld throughout — a moving deck is never
   *  aligned, so it is never released onto/off the turning bridge (the inner
   *  capacity-1 zone's clearance). */
  private route(): void {
    const cur = this.current;
    if (cur === null) return;
    if (this.timer < 0.4) {
      cur.train.stop(); // let the loco settle to a dead stand before the swing
      return;
    }
    this.d.deck.alignTo(cur.stallId);
    if (this.d.deck.alignedExit === cur.stallId) this.to('park');
  }

  /** The deck is seated on the stall: give ONE "go" and watch. Once the camera
   *  sees the loco parked in the bay, mark the stall occupied and FREE the deck —
   *  the interior is serialised, so freeing the deck lets the next arrival board.
   *  We command the drive once, then observe (the deck re-expresses the motor
   *  intent as it turned, so spamming forward would fight the spin). */
  private park(): void {
    const cur = this.current;
    if (cur === null) return;
    if (!this.parkCommanded) {
      cur.train.forward();
      this.parkCommanded = true;
    }
    const at = stallSensePoint(this.d.layout, this.stall(cur.stallId).stallSeg);
    if (this.d.look(at.x, at.y).occupied) {
      cur.train.stop();
      this.occupied.add(cur.stallId);
      this.current = null; // deck free again → the turntable can serve the next loco
      this.to('idle');
    }
  }
}
