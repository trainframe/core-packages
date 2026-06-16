/**
 * A dockside JIB CRANE as a physically-honest actuator (ADR-031 §2). Unlike the
 * Cartesian gantry (`crane.ts`), a jib has a STATIC base that PIVOTS: the boom
 * slews about the tower through an angle θ, and the hook runs out along the boom
 * to a reach r. Its workspace is therefore POLAR — an annular sector bounded by
 * the slew limits (minAngle…maxAngle) and the reach limits (minReach…maxReach).
 *
 * Each of the two axes is its own honest actuator:
 *   - slew θ: angular acceleration, a top angular rate, and endstops (the boom
 *     cannot swing past its bearing limits);
 *   - reach r: linear acceleration, a top rate, and endstops (the trolley cannot
 *     run past the boom tip, nor back inside the tower).
 * Neither is instantaneous and neither is animated by a controller. The
 * controller commands intent — `moveTo(θ, r)` or `aimAt(worldX, worldY)` — and
 * then awaits `arrived`; a target out of the workspace is CLAMPED to the nearest
 * physical limit (a point beyond the boom's reach parks the hook at maxReach, a
 * real mechanical limit), exactly as the gantry clamps at its endstops.
 *
 * `pos` is the hook's world (x, y), derived from the base + θ + r each read — no
 * separate position state to drift. Pure kinematics over a virtual clock (no
 * DOM, no Date.now); one concrete `PayloadCrane` behind the shared payload seam.
 */

import type { PayloadCrane } from './payload-crane.js';

export interface JibLimits {
  /** Slew limits (radians, measured from +x, counter-clockwise in world space). */
  readonly minAngle: number;
  readonly maxAngle: number;
  /** Reach limits (mm from the tower centre to the hook). */
  readonly minReach: number;
  readonly maxReach: number;
}

export interface JibConfig {
  /** The fixed world point the tower stands on (the slew pivot). */
  readonly base: { readonly x: number; readonly y: number };
  readonly limits: JibLimits;
  /** Initial slew angle (rad) and reach (mm); both clamped into the limits. */
  readonly start: { readonly angle: number; readonly reach: number };
}

/** Slew dynamics (rad). Gentle accel + a modest top rate, so the boom visibly
 *  eases into and out of the swing rather than tracking at a constant rate. */
const SLEW_ACCEL = 0.55;
const SLEW_MAX_RATE = 0.5;
const SLEW_ARRIVE_POS = 0.01; // rad
const SLEW_ARRIVE_RATE = 0.03; // rad/s

/** Reach dynamics (mm) — the trolley running out along the boom (also eased). */
const REACH_ACCEL = 280;
const REACH_MAX_RATE = 230;
const REACH_ARRIVE_POS = 4; // mm
const REACH_ARRIVE_RATE = 12; // mm/s

export class JibCrane implements PayloadCrane {
  private readonly base: { x: number; y: number };
  private readonly limits: JibLimits;
  private angle: number;
  private reach: number;
  private angleVel = 0;
  private reachVel = 0;
  private targetAngle: number;
  private targetReach: number;
  private holding = false;

  constructor(cfg: JibConfig) {
    this.base = { x: cfg.base.x, y: cfg.base.y };
    this.limits = cfg.limits;
    this.angle = this.clampAngle(cfg.start.angle);
    this.reach = this.clampReach(cfg.start.reach);
    this.targetAngle = this.angle;
    this.targetReach = this.reach;
  }

  /** The fixed pivot the boom slews about (for rendering the tower). */
  get pivot(): { x: number; y: number } {
    return { x: this.base.x, y: this.base.y };
  }

  /** The boom's current slew angle (rad) — read off the actuator to render it. */
  get slewAngle(): number {
    return this.angle;
  }

  /** The hook's current reach out along the boom (mm) — read to render it. */
  get reachOut(): number {
    return this.reach;
  }

  get carrying(): boolean {
    return this.holding;
  }

  grab(): void {
    this.holding = true;
  }

  release(): boolean {
    const had = this.holding;
    this.holding = false;
    return had;
  }

  /** The hook's world position, derived live from base + slew + reach. */
  get pos(): { x: number; y: number } {
    return {
      x: this.base.x + Math.cos(this.angle) * this.reach,
      y: this.base.y + Math.sin(this.angle) * this.reach,
    };
  }

  /** Whether both axes have reached their commanded target and stopped. */
  get arrived(): boolean {
    return (
      Math.abs(this.angle - this.targetAngle) <= SLEW_ARRIVE_POS &&
      Math.abs(this.angleVel) <= SLEW_ARRIVE_RATE &&
      Math.abs(this.reach - this.targetReach) <= REACH_ARRIVE_POS &&
      Math.abs(this.reachVel) <= REACH_ARRIVE_RATE
    );
  }

  /** Command the boom to a slew angle + reach, each clamped to its endstops. */
  moveTo(angle: number, reach: number): void {
    this.targetAngle = this.clampAngle(angle);
    this.targetReach = this.clampReach(reach);
  }

  /** Command the hook toward a world point: convert it to (θ, r) about the base,
   *  each clamped to the physical limits. A point out of reach parks the hook at
   *  the boom's max (an honest mechanical limit), still slewed to bear on it. */
  aimAt(worldX: number, worldY: number): void {
    const dx = worldX - this.base.x;
    const dy = worldY - this.base.y;
    const reach = Math.hypot(dx, dy);
    /* atan2 is undefined at the pivot itself; hold the current bearing there. */
    const angle = reach === 0 ? this.angle : Math.atan2(dy, dx);
    this.moveTo(angle, reach);
  }

  step(dtS: number): void {
    const [a, av] = solveAxis(
      this.angle,
      this.angleVel,
      this.targetAngle,
      dtS,
      SLEW_ACCEL,
      SLEW_MAX_RATE,
      SLEW_ARRIVE_POS,
      SLEW_ARRIVE_RATE,
    );
    const [r, rv] = solveAxis(
      this.reach,
      this.reachVel,
      this.targetReach,
      dtS,
      REACH_ACCEL,
      REACH_MAX_RATE,
      REACH_ARRIVE_POS,
      REACH_ARRIVE_RATE,
    );
    this.angle = a;
    this.angleVel = av;
    this.reach = r;
    this.reachVel = rv;
  }

  private clampAngle(a: number): number {
    return Math.max(this.limits.minAngle, Math.min(this.limits.maxAngle, a));
  }
  private clampReach(r: number): number {
    return Math.max(this.limits.minReach, Math.min(this.limits.maxReach, r));
  }
}

/** One axis of trapezoidal point-to-point motion (shared shape with the gantry's
 *  solver, parameterised per axis so slew and reach reuse it): accelerate toward
 *  the target, cap at the top rate, brake so it comes to rest on the target and
 *  never overshoots. Returns the next [position, velocity]. */
function solveAxis(
  pos: number,
  vel: number,
  target: number,
  dtS: number,
  accelMag: number,
  maxRate: number,
  arrivePos: number,
  arriveRate: number,
): [number, number] {
  const d = target - pos;
  if (Math.abs(d) <= arrivePos && Math.abs(vel) <= arriveRate) return [target, 0];

  const stopDist = (vel * vel) / (2 * accelMag);
  let accel: number;
  if (vel !== 0 && Math.sign(d) !== Math.sign(vel)) {
    accel = -Math.sign(vel) * accelMag; // moving the wrong way → brake
  } else if (Math.abs(d) <= stopDist) {
    accel = -Math.sign(vel) * accelMag; // close enough that we must brake onto target
  } else {
    accel = Math.sign(d) * accelMag; // open run → accelerate toward target
  }

  let nv = vel + accel * dtS;
  nv = Math.max(-maxRate, Math.min(maxRate, nv));
  let np = pos + nv * dtS;
  /* Don't sail past the target within a step — snap and kill velocity. */
  if (Math.sign(target - np) !== Math.sign(d) && d !== 0) {
    np = target;
    nv = 0;
  }
  return [np, nv];
}
