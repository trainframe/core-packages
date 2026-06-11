/**
 * The turntable deck as a physically-honest rotation actuator (ADR-031 §2). It
 * owns the PHYSICS of its own motion: a current angle, an angular acceleration, a
 * top angular rate, and travel-limit endstops — exactly as `devices/crane.ts`
 * gives each linear axis a trapezoidal accelerate-cruise-brake profile. A device
 * commands INTENT (`alignTo('stub-b')` → rotate to that exit's angle) and then
 * AWAITS the physical result (`arrived`); it never animates the angle itself and
 * never reads simulator ground truth.
 *
 * The deck also owns which exit link is live: while it is slewing NOTHING is
 * aligned (the junction has no active branch, so the network holds a train at the
 * approach — the "clearance" for this capacity-1 zone falls straight out of the
 * unset switch, per experimental/002). Only when the bridge has mechanically
 * SEATED on the target stub does it commit that exit by throwing the world's
 * switch — and a turn-around stub commits the facing-flip branch.
 *
 * Pure kinematics over a virtual clock (no DOM, no Date.now) — `step(dt)`
 * integrates, `alignTo`/`rotateTo` retarget, `pos`/`arrived`/`alignedExit` report.
 */
import type { SwitchActuator } from './switch-actuator.js';

/** One exit the deck can line its bridge up with: a switch POSITION label and the
 *  deck ANGLE (degrees) at which the bridge points at it. A turn-around exit
 *  (e.g. the loco-reversal stub) is whichever NetLink carries `flipsFacing` — the
 *  actuator only commits the position; the network owns the flip. */
export interface TurntableExit {
  readonly position: string;
  readonly angleDeg: number;
}

/** Rotation dynamics (degrees). Visible but unhurried — you can watch the deck
 *  swing round over a few seconds, the turntable's whole legibility point. */
const ANG_ACCEL = 70; // deg/s²
const MAX_RATE = 60; // deg/s
/** How close (deg) and slow (deg/s) counts as "seated" over the target angle. */
const ARRIVE_ANGLE = 0.4;
const ARRIVE_RATE = 1.5;

export class TurntableActuator {
  private readonly exits: ReadonlyMap<string, TurntableExit>;
  private readonly switchId: string;
  private readonly points: SwitchActuator;
  private readonly minAngle: number;
  private readonly maxAngle: number;
  private angle: number;
  private rate = 0;
  private target: number;
  /** The exit the deck is slewing toward (committed to the switch on arrival). */
  private targetExit: string | null = null;
  /** The exit currently SEATED (switch thrown), or null while mid-rotation. */
  private seated: string | null = null;

  constructor(deps: {
    readonly exits: readonly TurntableExit[];
    readonly switchId: string;
    readonly points: SwitchActuator;
    /** Endstops (deg): the deck cannot swing past these physical limits. */
    readonly limits: { readonly minDeg: number; readonly maxDeg: number };
    /** Starting deck angle (clamped into the limits). */
    readonly startDeg: number;
  }) {
    this.exits = new Map(deps.exits.map((e) => [e.position, e]));
    this.switchId = deps.switchId;
    this.points = deps.points;
    this.minAngle = deps.limits.minDeg;
    this.maxAngle = deps.limits.maxDeg;
    this.angle = this.clamp(deps.startDeg);
    this.target = this.angle;
    /* Seat whatever exit (if any) the deck already lines up with at start. */
    const at = this.exitAtAngle(this.angle);
    if (at !== null) {
      this.seated = at;
      this.targetExit = at;
      this.points.set(at);
    }
  }

  /** The deck's current angle (deg) — for rendering the rotating sub-shape. The
   *  view reads THIS real angle; it never animates its own. */
  get pos(): number {
    return this.angle;
  }

  /** Whether the deck has reached its commanded angle and effectively stopped. */
  get arrived(): boolean {
    return Math.abs(this.angle - this.target) <= ARRIVE_ANGLE && Math.abs(this.rate) <= ARRIVE_RATE;
  }

  /** The exit currently mechanically seated (switch thrown), or null while the
   *  deck is between exits — an unaligned deck withholds by simply not matching. */
  get alignedExit(): string | null {
    return this.seated;
  }

  /** Command the deck to line its bridge up with a named exit (the device's whole
   *  vocabulary). Clears the live branch immediately — the deck is no longer
   *  seated anywhere until it arrives — so a train is held off a moving deck. */
  alignTo(position: string): void {
    const exit = this.exits.get(position);
    if (exit === undefined) throw new Error(`turntable: no exit ${position}`);
    if (this.targetExit === position) return; // already heading there — idempotent
    this.targetExit = position;
    this.retarget(exit.angleDeg);
  }

  /** Retarget the deck angle directly (clamped to the endstops). Lower-level than
   *  `alignTo`; mostly for tests of the raw dynamics. Clears the seated exit (a
   *  raw angle no longer corresponds to a committed branch). */
  rotateTo(angleDeg: number): void {
    this.targetExit = null;
    this.retarget(angleDeg);
  }

  /** Set a new target angle and drop the seated exit — a fresh move means the deck
   *  is no longer aligned anywhere until it arrives. */
  private retarget(angleDeg: number): void {
    this.target = this.clamp(angleDeg);
    this.seated = null;
  }

  step(dtS: number): void {
    const [a, r] = solveRotation(this.angle, this.rate, this.target, dtS);
    this.angle = a;
    this.rate = r;
    /* On seating the target exit, commit it to the world switch — and ONLY then,
     * so the network never routes a train onto a moving or mis-aligned deck. */
    if (this.targetExit !== null && this.seated !== this.targetExit && this.arrived) {
      this.seated = this.targetExit;
      this.points.set(this.targetExit);
    }
  }

  private clamp(a: number): number {
    return Math.max(this.minAngle, Math.min(this.maxAngle, a));
  }

  /** The exit (if any) whose angle the deck is sitting on right now. */
  private exitAtAngle(a: number): string | null {
    for (const e of this.exits.values()) {
      if (Math.abs(e.angleDeg - a) <= ARRIVE_ANGLE) return e.position;
    }
    return null;
  }
}

/** Trapezoidal point-to-point rotation: accelerate toward the target angle, cap
 *  at the top rate, brake so the deck seats on it without overshooting (mirrors
 *  `crane.ts`'s `solveAxis`, in the angular domain). */
function solveRotation(angle: number, rate: number, target: number, dtS: number): [number, number] {
  const d = target - angle;
  if (Math.abs(d) <= ARRIVE_ANGLE && Math.abs(rate) <= ARRIVE_RATE) return [target, 0];

  const stopDist = (rate * rate) / (2 * ANG_ACCEL);
  let accel: number;
  if (rate !== 0 && Math.sign(d) !== Math.sign(rate)) {
    accel = -Math.sign(rate) * ANG_ACCEL; // turning the wrong way → brake
  } else if (Math.abs(d) <= stopDist) {
    accel = -Math.sign(rate) * ANG_ACCEL; // close enough that we must brake to seat
  } else {
    accel = Math.sign(d) * ANG_ACCEL; // open swing → accelerate toward target
  }

  let nr = rate + accel * dtS;
  nr = Math.max(-MAX_RATE, Math.min(MAX_RATE, nr));
  let na = angle + nr * dtS;
  /* Don't swing past the target within a step — snap and kill the rate. */
  if (Math.sign(target - na) !== Math.sign(d) && d !== 0) {
    na = target;
    nr = 0;
  }
  return [na, nr];
}
