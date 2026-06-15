/**
 * The reverse-in railyard as a CV-driven controller (ADR-030 §4), for the
 * trailing-turnout ladder (`yard-ladder.ts`). It perceives ONLY through a camera
 * (`look(x,y)` — what's beneath a footprint it positions on the gantry) and acts
 * ONLY through actuators: the visiting train's motor, the throat + ladder points,
 * and the crane wedge. Nothing is keyframed — the train self-drives real rails and
 * the crane only ever decouples.
 *
 * One service, a train arriving at the throat (FROZEN per ADR-029, reworked for
 * reverse-in):
 *
 *   pull-in   throat→enter, every ladder point→thru; drive forward down the lead
 *             until the loco rests on the headshunt (clear of every slot turnout)
 *   choose    scan each slot by camera; pick the first FREE one, throw its point
 *   set-back  reverse: the trailing turnout backs the rake into the slot rear-first,
 *             the loco coming to rest at the slot MOUTH
 *   uncouple  drive the crane over the coupling behind the loco; split it (cut stays)
 *   pull-out  drive forward: the loco pulls out of the slot, leaving the cut parked
 *   done
 *
 * Geometry it can't see it derives by LOOKING (a slot is free if the camera over it
 * is clear; the loco's rest is where the camera finds it). Tick-driven over a
 * virtual clock; pure (no DOM, no Date.now, no Math.random).
 */
import type { Crane } from './crane.js';
import type { SwitchActuator } from './switch-actuator.js';
import type { TrainDevice } from './train-device.js';

/** What the crane camera reports beneath its footprint. */
export interface Sighting {
  readonly occupied: boolean;
  readonly colour?: string | undefined;
  /** World centre of the body seen (the nearest under the footprint), if any — so
   *  the controller can place the wedge relative to where a body actually is, never
   *  reading the world's body list. */
  readonly at?: { x: number; y: number } | undefined;
}

/** World geometry of one dead-end slot: its mouth (at the turnout) and buffer (the
 *  dead end). The rake parks between them; the loco rests at the mouth. */
export interface SlotGeom {
  readonly mouth: { x: number; y: number };
  readonly buffer: { x: number; y: number };
}

export interface LadderYardControllerDeps {
  readonly train: TrainDevice;
  /** Throat points: `enter` admits to the lead, `thru` keeps the running line. */
  readonly throat: SwitchActuator;
  readonly enterPos: string;
  readonly thruPos: string;
  /** One actuator per ladder turnout; `slotPos` diverts the reverse into its slot. */
  readonly ladder: readonly SwitchActuator[];
  readonly ladderThruPos: string;
  readonly ladderSlotPos: string;
  /** Each slot's world geometry, indexed to match `ladder`. */
  readonly slots: readonly SlotGeom[];
  /** Where the loco comes to rest when pulled fully onto the headshunt. */
  readonly headshuntRest: { x: number; y: number };
  /** Position the camera at world (x,y) and read what's beneath it. */
  readonly look: (x: number, y: number) => Sighting;
  /** The camera footprint radius (mm). */
  readonly cameraRadius: number;
  /** Lower the wedge at world (x,y) to split the coupling there. */
  readonly wedgeAt: (x: number, y: number) => void;
  /** The shared gantry crane (owned + stepped by the caller). */
  readonly crane: Crane;
}

type Phase = 'pull-in' | 'choose' | 'set-back' | 'uncouple' | 'pull-out' | 'done';

/** Distance a car centre sits from the next (mm) — the rake's spacing. */
const CAR_SPACING = 68;

export class LadderYardController {
  private readonly d: LadderYardControllerDeps;
  private readonly crane: Crane;
  private phase: Phase = 'pull-in';
  private timer = 0;
  /** The slot the service chose (−1 until `choose` picks a free one). */
  private chosen = -1;
  /** The coupling world point the crane splits (null until found). */
  private cut: { x: number; y: number } | null = null;
  /** Pull-out progress: set once the loco has reached the slot mouth, so the exit is
   *  detected as the loco PASSING the mouth (reached, then gone), not merely absent. */
  private reachedMouth = false;

  constructor(deps: LadderYardControllerDeps) {
    this.d = deps;
    this.crane = deps.crane;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  /** The slot this service is using (−1 before one is chosen) — the device reports
   *  it for rendering / per-slot occupancy. */
  get chosenSlot(): number {
    return this.chosen;
  }

  private to(phase: Phase): void {
    this.phase = phase;
    this.timer = 0;
  }

  /** The world point the crane is currently working over (its commanded target). */
  private focus(): { x: number; y: number } {
    if (this.chosen < 0) return this.crane.pos; // nothing to work yet
    const slot = this.d.slots[this.chosen];
    if (slot === undefined) return this.crane.pos;
    return this.cut ?? slot.mouth;
  }

  tick(dtS: number): void {
    this.timer += dtS;
    const f = this.focus();
    this.crane.moveTo(f.x, f.y);
    switch (this.phase) {
      case 'pull-in':
        this.pullIn();
        break;
      case 'choose':
        this.choose();
        break;
      case 'set-back':
        this.setBack();
        break;
      case 'uncouple':
        this.uncouple();
        break;
      case 'pull-out':
        this.pullOut();
        break;
      case 'done':
        break;
    }
  }

  /** Throat to the lead, every slot turnout thru; pull forward until the loco rests
   *  on the headshunt (where the camera finds it), clear of every slot turnout. */
  private pullIn(): void {
    this.d.throat.set(this.d.enterPos);
    for (const sw of this.d.ladder) sw.set(this.d.ladderThruPos);
    this.d.train.forward();
    const r = this.d.headshuntRest;
    if (this.timer > 0.4 && this.d.look(r.x, r.y).occupied) {
      this.d.train.stop();
      this.to('choose');
    }
  }

  /** Scan each slot by camera; choose the first FREE one and throw its turnout. */
  private choose(): void {
    for (let i = 0; i < this.d.slots.length; i++) {
      const slot = this.d.slots[i];
      if (slot === undefined) continue;
      const occupied =
        this.d.look(slot.mouth.x, slot.mouth.y).occupied ||
        this.d.look(slot.buffer.x, slot.buffer.y).occupied;
      if (!occupied) {
        this.chosen = i;
        break;
      }
    }
    if (this.chosen < 0) {
      /* No free slot — nothing to do; release immediately (the device frees it). */
      this.to('done');
      return;
    }
    for (let i = 0; i < this.d.ladder.length; i++) {
      this.d.ladder[i]?.set(i === this.chosen ? this.d.ladderSlotPos : this.d.ladderThruPos);
    }
    this.to('set-back');
  }

  /** Reverse: the trailing turnout backs the rake into the chosen slot; stop once
   *  the rear of the rake has seated against the buffer (the camera at the dead end
   *  sees it), so the whole cut is inside the slot and the loco rests near the mouth. */
  private setBack(): void {
    const slot = this.d.slots[this.chosen];
    if (slot === undefined) {
      this.to('done');
      return;
    }
    this.d.train.reverse();
    if (this.timer > 0.4 && this.d.look(slot.buffer.x, slot.buffer.y).occupied) {
      this.d.train.stop();
      this.to('uncouple');
    }
  }

  /** Drive the crane over the coupling just behind the loco (toward the buffer) and,
   *  once the head has arrived, lower the wedge — the cut stays parked in the slot. */
  private uncouple(): void {
    if (this.timer < 0.4) return; // let the rake settle
    const slot = this.d.slots[this.chosen];
    if (slot === undefined) {
      this.to('done');
      return;
    }
    if (this.cut === null) {
      const found = this.couplingBehindLoco(slot);
      if (found === null) return; // loco not yet sighted at the mouth; keep waiting
      this.cut = found;
      return; // crane now travels toward it (commanded in tick)
    }
    if (!this.crane.arrived) return;
    this.d.wedgeAt(this.cut.x, this.cut.y);
    this.to('pull-out');
  }

  /** The coupling just behind the loco: scan from the mouth toward the buffer and
   *  collect the first TWO distinct body centres (the loco nearest the mouth, then the
   *  first parked car). Their MIDPOINT is the loco↔car coupling — exact whatever the
   *  rake's spacing. Null until both are found (the rake may still be settling). */
  private couplingBehindLoco(slot: SlotGeom): { x: number; y: number } | null {
    const dx = slot.buffer.x - slot.mouth.x;
    const dy = slot.buffer.y - slot.mouth.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const found: { x: number; y: number }[] = [];
    const step = this.d.cameraRadius / 2;
    for (let s = 0; s <= len && found.length < 2; s += step) {
      const sight = this.d.look(slot.mouth.x + ux * s, slot.mouth.y + uy * s);
      if (!sight.occupied || sight.at === undefined) continue;
      const last = found[found.length - 1];
      /* Dedupe successive sightings of the SAME body (same centre under the moving
       *  footprint) — only a centre a car-spacing on is a new body. */
      if (
        last === undefined ||
        Math.hypot(sight.at.x - last.x, sight.at.y - last.y) > CAR_SPACING / 2
      ) {
        found.push({ x: sight.at.x, y: sight.at.y });
      }
    }
    const loco = found[0];
    const car = found[1];
    if (loco === undefined || car === undefined) return null;
    return { x: (loco.x + car.x) / 2, y: (loco.y + car.y) / 2 };
  }

  /** Pull the loco forward out of the slot: it resting deep in the slot, the camera
   *  at the mouth is clear at first, so we wait for the loco to REACH the mouth and
   *  then PASS it (camera clear again) — that is the loco out onto the lead, clear of
   *  the parked cut. */
  private pullOut(): void {
    const slot = this.d.slots[this.chosen];
    if (slot === undefined) {
      this.to('done');
      return;
    }
    this.d.train.forward();
    const atMouth = this.d.look(slot.mouth.x, slot.mouth.y).occupied;
    if (atMouth) this.reachedMouth = true;
    if (this.reachedMouth && !atMouth) {
      this.d.train.stop();
      this.to('done');
    }
  }
}
