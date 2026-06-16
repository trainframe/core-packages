/**
 * The turntable as a portable controller (ADR-030 §1, ADR-031). It runs ONE
 * service — turn a visiting loco around — perceiving ONLY through a camera-look
 * and acting ONLY through actuators: the train's motor and the `TurntableActuator`
 * (the deck). Nothing is keyframed; the deck owns its rotation physics and the
 * controller only COMMANDS intent and AWAITS the physical result (`arrived`).
 *
 *   approach   align the deck to the TRUNK; drive the loco on toward the deck
 *   board      creep until the camera sees the loco seated on the deck centre; stop
 *   turn       command the deck to the chosen EXIT (a 180° turn-around) and wait
 *              for it to physically seat — the loco's motion stays WITHHELD here,
 *              the capacity-1 zone's clearance (a moving deck is not aligned, so
 *              nothing routes onto/off it)
 *   leave      the deck is seated → release: drive forward off the deck. Crossing
 *              the turn-around link reverses the loco's facing, so it departs
 *              FACING THE OTHER WAY
 *   done       the loco has cleared the deck onto the exit stub
 *
 * It learns the loco's position by LOOKING (the deck-centre sighting), never by
 * reading ground truth. Tick-driven over a virtual clock; pure (no DOM, no
 * Date.now).
 */
import type { TrainDevice } from './train-device.js';
import type { TurntableActuator } from './turntable-actuator.js';

/** What the camera reports beneath its footprint (the same shape the yard uses). */
export interface Sighting {
  readonly occupied: boolean;
  readonly colour?: string | undefined;
}

export interface TurntableControllerDeps {
  readonly train: TrainDevice;
  readonly deck: TurntableActuator;
  /** Look at world (x,y) and report what's beneath the footprint there. */
  readonly look: (x: number, y: number) => Sighting;
  /** The deck-centre world point — where the loco must come to rest to be turned. */
  readonly deckCentre: { readonly x: number; readonly y: number };
  /** The deck exit the loco arrives over (so the deck lines up for boarding). */
  readonly trunkExit: string;
  /** The deck exit the loco leaves by (the turn-around stub). */
  readonly departExit: string;
  /** A world point out on the departure stub, clear of the deck — the loco has
   *  finished leaving once it is sensed here. */
  readonly departSensePoint: { readonly x: number; readonly y: number };
}

type Phase = 'approach' | 'board' | 'turn' | 'leave' | 'done';

export class TurntableController {
  private readonly d: TurntableControllerDeps;
  private phase: Phase = 'approach';
  private timer = 0;
  /** Whether the single "go" for the leave phase has been issued. */
  private leaveCommanded = false;

  constructor(deps: TurntableControllerDeps) {
    this.d = deps;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  tick(dtS: number): void {
    this.timer += dtS;
    /* The deck owns its own rotation physics; we only step it. */
    this.d.deck.step(dtS);
    switch (this.phase) {
      case 'approach':
        this.approach();
        break;
      case 'board':
        this.board();
        break;
      case 'turn':
        this.turn();
        break;
      case 'leave':
        this.leave();
        break;
      case 'done':
        break;
    }
  }

  private to(phase: Phase): void {
    this.phase = phase;
    this.timer = 0;
  }

  /** Line the deck up with the trunk, then — once it is seated — drive the loco on. */
  private approach(): void {
    this.d.deck.alignTo(this.d.trunkExit);
    /* Hold the loco off the deck until the bridge is mechanically aligned. */
    if (this.d.deck.alignedExit !== this.d.trunkExit) {
      this.d.train.stop();
      return;
    }
    this.d.train.forward();
    this.to('board');
  }

  /** Watch the deck centre; when the loco is seen there, stop on it. */
  private board(): void {
    if (this.d.look(this.d.deckCentre.x, this.d.deckCentre.y).occupied) {
      this.d.train.stop();
      this.to('turn');
    }
  }

  /** Command the deck to the departure exit and AWAIT the physical swing. The
   *  loco's motion is withheld throughout — a moving deck is never aligned, so it
   *  is never released onto/off the turning bridge. */
  private turn(): void {
    if (this.timer < 0.4) {
      this.d.train.stop(); // let the loco settle to a dead stand first
      return;
    }
    this.d.deck.alignTo(this.d.departExit);
    if (this.d.deck.alignedExit === this.d.departExit) this.to('leave');
  }

  /** The deck has seated on the departure stub: give ONE "go" and then watch. We
   *  do not spam the motor — crossing the turn-around link physically turns the
   *  loco (facing reverses, the motor's "forward" now points the other way), so a
   *  controller that re-asserted "forward" each tick would be fighting the spin.
   *  A real controller issues a drive command and observes the result, which is
   *  exactly what we do: command once, then poll the camera. */
  private leave(): void {
    if (!this.leaveCommanded) {
      this.d.train.forward();
      this.leaveCommanded = true;
    }
    /* Done once the loco is sensed out on the departure stub — it has crossed the
     * turn-around link (facing now reversed) and is clear of the deck. */
    if (this.d.look(this.d.departSensePoint.x, this.d.departSensePoint.y).occupied) {
      this.d.train.stop();
      this.to('done');
    }
  }
}
