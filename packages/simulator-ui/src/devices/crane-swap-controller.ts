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
  /** Keep cycling: after a swap, dwell, then SWAP the holding/spares roles and run
   *  again — so the rake the crane just shed becomes the next train's spares and the
   *  device services train after train. Default false (one swap, then `done`). */
  readonly loop?: boolean;
}

type Phase = 'to-rear' | 'to-holding' | 'to-spares' | 'to-train' | 'done';

/** How long (s) the crane rests on a finished swap before looping to the next. */
const LOOP_REST_S = 1.2;

export class CraneSwapController {
  private readonly d: CraneSwapDeps;
  private readonly crane: Crane;
  private phase: Phase = 'to-rear';
  private held: readonly string[] = [];
  /** Small settle so the crane is seen to arrive + dwell before it lifts/places. */
  private dwell = 0;
  /** Mutable drop points — the holding/spares roles SWAP each loop (the shed cut
   *  becomes the next spares), so a looping crane services train after train. */
  private holding: { x: number; y: number };
  private spares: { x: number; y: number };

  constructor(deps: CraneSwapDeps) {
    this.d = deps;
    this.crane = deps.crane;
    this.holding = deps.holding;
    this.spares = deps.spares;
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
        this.travel(this.holding, dtS, () => {
          this.d.placeCut(this.held, this.holding.x, this.holding.y);
          this.crane.release();
          this.held = [];
          this.to('to-spares');
        });
        break;
      case 'to-spares':
        this.travel(this.spares, dtS, () => {
          this.held = this.d.liftCut(this.spares.x, this.spares.y);
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
        if (this.d.loop === true) {
          /* Rest on the finished swap, then SWAP holding/spares (the cut just shed
           *  is the next train's spares) and run the cycle again. */
          this.dwell += dtS;
          if (this.dwell >= LOOP_REST_S) {
            const oldHolding = this.holding;
            this.holding = this.spares;
            this.spares = oldHolding;
            this.to('to-rear');
          }
        }
        break;
    }
  }
}
