/**
 * The railyard as a CV-driven controller (ADR-030 Plan §4). It perceives ONLY
 * through a camera (`look(x,y)` — what's beneath a footprint it positions on the
 * gantry) and acts ONLY through actuators: the visiting train's motor, the two
 * ladder-switch points, and the crane wedge (`wedgeAt(x,y)` splits whatever
 * coupling is under it). Nothing is keyframed — the train self-drives real rails,
 * carriages couple by magnetic proximity, and the crane only ever decouples.
 *
 * One service, train arriving at the WEST throat (the mirror works the same from
 * the east — the yard keys off where the train actually is, never a fixed IN):
 *
 *   route-in   throw the west points to a free slot; drive in
 *   rest       creep until the camera sees the loco at the slot's far end; stop
 *   decouple   position the wedge over the rear coupling; split it (shed cut stays)
 *   pull-clear open the slot's east exit; pull forward onto the east lead, clear
 *   to-spares  throw the east points to the spares slot; reverse on until coupled
 *   settle     nudge forward to seat the picked-up rake
 *   exit       drive forward out the opposite (east) throat
 *
 * Geometry-aware but state it can't see it derives by LOOKING (the loco's rest x
 * is whatever the camera reports, the cut is relative to that). Tick-driven over
 * a virtual clock; pure (no DOM, no Date.now).
 */
import type { YardLayout, YardSegGeom } from '../physics/yard.js';
import type { Crane, CraneBounds } from './crane.js';
import type { SwitchActuator } from './switch-actuator.js';
import type { TrainDevice } from './train-device.js';

/** What the crane camera reports beneath its footprint. */
export interface Sighting {
  readonly occupied: boolean;
  readonly colour?: string | undefined;
}

export interface YardControllerDeps {
  readonly layout: YardLayout;
  readonly train: TrainDevice;
  /** The west diverge points (Jw) and east converge points (Je). */
  readonly westPoints: SwitchActuator;
  readonly eastPoints: SwitchActuator;
  /** Position the camera at world (x,y) and read what's beneath it. */
  readonly look: (x: number, y: number) => Sighting;
  /** The camera footprint radius (mm) — the device knows its own sensor, so it can
   *  correct edge readings (a body is first seen one radius before its centre). */
  readonly cameraRadius: number;
  /** Lower the wedge at world (x,y) to split the coupling there. */
  readonly wedgeAt: (x: number, y: number) => void;
  /** The gantry crane actuator. INJECTED and owned by the caller — a single
   *  persistent physical crane is shared across successive services and stepped by
   *  the owner, so its head only ever travels (never jumps between services). The
   *  controller commands it (`moveTo`) and reads it (`pos`/`arrived`) but does not
   *  create or step it. */
  readonly crane: Crane;
  /** Which slot the visitor enters, and which holds the spares. */
  readonly entrySlot: string;
  readonly sparesSlot: string;
}

type Phase =
  | 'route-in'
  | 'rest'
  | 'decouple'
  | 'pull-clear'
  | 'to-spares'
  | 'settle'
  | 'exit'
  | 'done';

const CAR_SPACING = 68;
/** How many cars the yard sheds (the rear cut). */
const SHED_CARS = 2;
/** Camera footprint nudge in from a slot's far end, where the loco should rest. */
const REST_INSET = 90;

export class YardController {
  private readonly d: YardControllerDeps;
  private readonly crane: Crane;
  private phase: Phase = 'route-in';
  private timer = 0;
  /** The loco's sensed rest x in the entry slot (set when it's seen to arrive). */
  private restX = 0;
  /** The sensed east edge of the spares (found by scanning the spares slot). */
  private sparesEastX = 0;
  /** The cut's world point, once the rake has been scanned (null until then). */
  private cut: { x: number; y: number } | null = null;

  constructor(deps: YardControllerDeps) {
    this.d = deps;
    this.crane = deps.crane;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  /** Where the crane head actually is on the gantry (for rendering) — it travels
   *  there over time, so this trails the point of interest until the head catches up. */
  get cranePos(): { x: number; y: number } {
    return this.crane.pos;
  }

  /** The point the crane is currently working over — its commanded target. The head
   *  takes time to reach it; sensing/wedging waits on `crane.arrived`. */
  private focus(): { x: number; y: number } {
    const entry = this.slot(this.d.entrySlot);
    const spares = this.slot(this.d.sparesSlot);
    switch (this.phase) {
      case 'route-in':
      case 'rest':
        /* Stay put while the train routes in and settles — the crane has no
         *  business over the slot until it has SOMETHING to work. It only commits
         *  to a position once it has scanned the arrived rake (decouple), so it
         *  reacts to what it senses rather than anticipating the route. */
        return this.crane.pos;
      case 'decouple':
        return this.cut ?? { x: this.restX - 1.5 * CAR_SPACING, y: entry.by };
      case 'pull-clear':
        return this.eastLeadPoint();
      case 'to-spares':
      case 'settle':
        return { x: this.sparesEastX || spares.ax + 200, y: spares.by };
      default:
        return { x: this.slot(this.d.layout.leadEast).bx - 60, y: spares.by };
    }
  }

  /** Geometry of a slot (its world endpoints). */
  private slot(id: string): YardSegGeom {
    const g = this.d.layout.geom.get(id);
    if (g === undefined) throw new Error(`yard: no slot ${id}`);
    return g;
  }

  /** The far (east) end of a slot — the rest target for a westbound arrival. */
  private slotFarEnd(id: string): { x: number; y: number } {
    const g = this.slot(id);
    return { x: g.bx - REST_INSET, y: g.by };
  }

  /** A point out on the east lead, clear of the ladder. */
  private eastLeadPoint(): { x: number; y: number } {
    const g = this.slot(this.d.layout.leadEast);
    return { x: (g.ax + g.bx) / 2, y: g.by };
  }

  tick(dtS: number): void {
    this.timer += dtS;
    /* Command the gantry toward the current work point. The owner steps the shared
     *  crane actuator (it travels physically there over time). */
    const f = this.focus();
    this.crane.moveTo(f.x, f.y);
    switch (this.phase) {
      case 'route-in':
        this.routeIn();
        break;
      case 'rest':
        this.rest();
        break;
      case 'decouple':
        this.decouple();
        break;
      case 'pull-clear':
        this.pullClear();
        break;
      case 'to-spares':
        this.toSpares();
        break;
      case 'settle':
        this.settle();
        break;
      case 'exit':
        this.exit();
        break;
      case 'done':
        break;
    }
  }

  private to(phase: Phase): void {
    this.phase = phase;
    this.timer = 0;
  }

  /** Throw the west points to the entry slot and drive in. */
  private routeIn(): void {
    this.d.westPoints.set(this.entrySlotPos());
    this.d.eastPoints.set('thru'); // keep the slot a dead-end so the train must stop
    this.d.train.forward();
    this.to('rest');
  }

  /** Watch the slot's far end; when the loco arrives there, stop. */
  private rest(): void {
    const at = this.slotFarEnd(this.d.entrySlot);
    if (this.d.look(at.x, at.y).occupied) {
      this.d.train.stop();
      this.restX = at.x;
      this.to('decouple');
    }
  }

  /** Let it settle, scan the rake to locate the cut, then drive the crane over
   *  that coupling and — once the head has physically arrived — lower the wedge.
   *  The yard learns the rake's extent by LOOKING, not by being told. */
  private decouple(): void {
    if (this.timer < 0.6) return; // let the train brake to a stand
    if (this.cut === null) {
      this.cut = this.findCut();
      return; // crane now starts travelling toward it (commanded in tick)
    }
    /* Wait for the gantry to reach the coupling before splitting it. */
    if (!this.crane.arrived) return;
    this.d.wedgeAt(this.cut.x, this.cut.y);
    this.to('pull-clear');
  }

  /** Scan the entry slot to find the rear cut's coupling point. */
  private findCut(): { x: number; y: number } {
    const y = this.slot(this.d.entrySlot).by;
    const r = this.d.cameraRadius;
    // Find the loco's front edge (eastmost occupied) by scanning east→west; its
    // centre is one camera-radius back from where the camera first sees it.
    let frontX = this.restX;
    for (let x = this.restX + 200; x > this.restX - 200; x -= 6) {
      if (this.d.look(x, y).occupied) {
        frontX = x;
        break;
      }
    }
    const locoCentre = frontX - r;
    // Count carriages by looking at each car centre behind the loco.
    let cars = 0;
    for (let k = 1; k <= 8; k++) {
      if (this.d.look(locoCentre - k * CAR_SPACING, y).occupied) cars = k;
      else break;
    }
    // Keep the loco + (cars − SHED_CARS) front carriages; split off the rear cut.
    const keptCars = Math.max(0, cars - SHED_CARS);
    return { x: locoCentre - (keptCars + 0.5) * CAR_SPACING, y };
  }

  /** Open the slot's east exit and pull forward onto the lead, clear of the slot. */
  private pullClear(): void {
    if (this.timer < 0.2) return;
    this.d.eastPoints.set(this.entrySlotPos());
    this.d.train.forward();
    const at = this.eastLeadPoint();
    if (this.timer > 0.4 && this.d.look(at.x, at.y).occupied) {
      this.d.train.stop();
      this.to('to-spares');
    }
  }

  /** Throw the east points to the spares slot and reverse onto the spares. First
   *  scan the spares slot to find where the spares sit (the train isn't in it
   *  yet, so the camera sees only them), then back on until the rake arrives just
   *  east of them — where magnetic proximity couples it. */
  private toSpares(): void {
    if (this.timer < 0.4) return;
    const g = this.slot(this.d.sparesSlot);
    if (this.sparesEastX === 0) {
      for (let x = g.bx; x > g.ax; x -= 6) {
        if (this.d.look(x, g.by).occupied) {
          this.sparesEastX = x;
          break;
        }
      }
      if (this.sparesEastX === 0) this.sparesEastX = g.ax + 200; // fallback
      this.d.eastPoints.set(this.sparesSlotPos());
      this.d.train.reverse();
      return;
    }
    // The rake's rear reaches just east of the spares → coupled by proximity.
    if (this.d.look(this.sparesEastX + 20, g.by).occupied) {
      this.d.train.stop();
      this.to('settle');
    }
  }

  /** Nudge forward to seat the picked-up rake, then leave. */
  private settle(): void {
    if (this.timer < 0.3) return;
    this.d.train.forward();
    if (this.timer > 1.0) this.to('exit');
  }

  /** Drive forward out the opposite throat, then hand off (stop on the lead so it
   *  doesn't run off the open end — in the full system core reclaims it here). */
  private exit(): void {
    this.d.eastPoints.set(this.sparesSlotPos());
    this.d.train.forward();
    // Done once the train has cleared out onto the east lead.
    const g = this.slot(this.d.layout.leadEast);
    if (this.d.look(g.bx - 60, g.by).occupied) {
      this.d.train.stop();
      this.to('done');
    }
  }

  /** Switch positions: slot ids map to the 'slotA'/'slotB' positions. */
  private entrySlotPos(): string {
    return this.d.entrySlot;
  }
  private sparesSlotPos(): string {
    return this.d.sparesSlot;
  }
}

/** The crane's physical travel limits (endstops): the bounding box of every yard
 *  segment, so the gantry can reach any work point but no further. Exported so the
 *  owner can build the single shared `Crane` actuator with the right bounds. */
export function craneBounds(layout: YardLayout): CraneBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const g of layout.geom.values()) {
    minX = Math.min(minX, g.ax, g.bx);
    maxX = Math.max(maxX, g.ax, g.bx);
    minY = Math.min(minY, g.ay, g.by);
    maxY = Math.max(maxY, g.ay, g.by);
  }
  return { minX, maxX, minY, maxY };
}
