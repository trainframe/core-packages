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
 * NESTING NOTE: ADR-031's `PlatformProvider` interface (the device↔core seam) is
 * only DRAFTED, not built. So for this v1 the depot orchestrates the turntable
 * DIRECTLY as an interior sub-device — it holds the `TurntableActuator`, commands
 * its intent, and reads its `arrived` / `alignedExit` to decide clearance. That
 * direct ownership IS the nesting. The `TurntableActuator` itself does not know
 * whether the thing commanding it is the real core or this depot — which is the
 * whole point. When ADR-031 lands, this seam becomes a platform-provider the
 * depot implements toward the turntable; until then it is a method call.
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
import type { DepotLayout, DepotStall } from '../physics/depot.js';
import { stallSensePoint } from '../physics/depot.js';
import type { TrainDevice } from './train-device.js';
import type { TurntableActuator } from './turntable-actuator.js';

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

  constructor(deps: DepotControllerDeps) {
    this.d = deps;
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
     *  parent-core, only steps it (the platform-provider seam once ADR-031 lands). */
    this.d.deck.step(dtS);
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
