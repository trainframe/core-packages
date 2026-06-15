/**
 * The railyard's CRANE-SWAP controller — the test device (experimental railyard): a
 * gantry crane that, when a train is parked in the yard, LIFTS the train's rear two
 * carriages off, holds them, lifts the two SPARE carriages, and sets them on the
 * train in their place — swapping the rake. The lifted-out cars become the spares for
 * the next train (so it loops).
 *
 * The crane only ever LIFTS and PLACES (option A — no shunting): it perceives nothing
 * it can't reach and acts only through the `Crane` actuator + the injected lift/place
 * operations (the sim-backing removes/re-seats the world bodies; on hardware those are
 * the electromagnet + a vision fix). Tick-driven over a virtual clock; pure (no DOM,
 * no Date.now, no Math.random). The crane MOVES because it has a job — never on a
 * timer.
 */
import type { Crane } from './crane.js';

export interface CraneSwapDeps {
  /** The gantry crane (owned + stepped by the caller). */
  readonly crane: Crane;
  /** Lift the cut (the rear cars / the spares) near (x,y) off the rails; returns the
   *  ids now on the hook. The caller removes them from the world. */
  readonly liftCut: (x: number, y: number) => readonly string[];
  /** Set the held cut down at (x,y), coupling its cars together and onto a loco if one
   *  is parked there. The caller re-seats them on the rails. */
  readonly placeCut: (ids: readonly string[], x: number, y: number) => void;
  /** Where the visiting train's rear cut sits (to lift off). */
  readonly trainRear: { x: number; y: number };
  /** Where to set the lifted train cut down (it becomes the next train's spares). */
  readonly holding: { x: number; y: number };
  /** Where the spare cut sits (to lift). */
  readonly spares: { x: number; y: number };
  /** Where to set the spares onto the train (couples to the loco). */
  readonly trainCouple: { x: number; y: number };
}

type Phase = 'to-rear' | 'to-holding' | 'to-spares' | 'to-train' | 'done';

export class CraneSwapController {
  private readonly d: CraneSwapDeps;
  private readonly crane: Crane;
  private phase: Phase = 'to-rear';
  private held: readonly string[] = [];
  /** Small settle so the crane is seen to arrive + dwell before it lifts/places. */
  private dwell = 0;

  constructor(deps: CraneSwapDeps) {
    this.d = deps;
    this.crane = deps.crane;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  /** Whether the head is carrying a cut (for rendering the hook). */
  get carrying(): boolean {
    return this.crane.carrying;
  }

  private to(phase: Phase): void {
    this.phase = phase;
    this.dwell = 0;
  }

  /** Drive the crane to `at`; once it has arrived and dwelled, run `onArrive` and
   *  advance. Returns true while still travelling (so the caller keeps stepping). */
  private travel(at: { x: number; y: number }, dtS: number, onArrive: () => void): void {
    this.crane.moveTo(at.x, at.y);
    if (!this.crane.arrived) {
      this.dwell = 0;
      return;
    }
    this.dwell += dtS;
    if (this.dwell >= 0.4) onArrive();
  }

  tick(dtS: number): void {
    switch (this.phase) {
      case 'to-rear':
        this.travel(this.d.trainRear, dtS, () => {
          this.held = this.d.liftCut(this.d.trainRear.x, this.d.trainRear.y);
          this.crane.grab();
          this.to('to-holding');
        });
        break;
      case 'to-holding':
        this.travel(this.d.holding, dtS, () => {
          this.d.placeCut(this.held, this.d.holding.x, this.d.holding.y);
          this.crane.release();
          this.held = [];
          this.to('to-spares');
        });
        break;
      case 'to-spares':
        this.travel(this.d.spares, dtS, () => {
          this.held = this.d.liftCut(this.d.spares.x, this.d.spares.y);
          this.crane.grab();
          this.to('to-train');
        });
        break;
      case 'to-train':
        this.travel(this.d.trainCouple, dtS, () => {
          this.d.placeCut(this.held, this.d.trainCouple.x, this.d.trainCouple.y);
          this.crane.release();
          this.held = [];
          this.to('done');
        });
        break;
      case 'done':
        break;
    }
  }
}
