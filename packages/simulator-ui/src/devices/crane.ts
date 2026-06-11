/**
 * The railyard crane as a physical XY gantry (ADR-030 Plan §4). Two actuators —
 * the bridge rolling along the running rails (x) and the head travelling along
 * the truss (y) — carry the camera + wedge. Neither is instantaneous: each axis
 * accelerates, runs up to a top speed, and brakes to a halt over its target, so
 * the controller sees the crane TAKE TIME to reach a coupling and must wait for
 * it to arrive before lowering the wedge. Travel is bounded by physical endstops
 * (`bounds`); a commanded move past them is clamped, exactly as a real gantry
 * jams against its limit switch.
 *
 * Pure kinematics over a virtual clock (no DOM, no Date.now) — `step(dt)`
 * integrates, `moveTo` retargets, `pos`/`arrived` report.
 */

export interface CraneBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Gantry dynamics (world mm). Visible but unhurried — you can watch it travel. */
const ACCEL = 900;
const MAX_SPEED = 520;
/** How close (mm) and slow (mm/s) counts as "arrived" over the target. */
const ARRIVE_DIST = 4;
const ARRIVE_SPEED = 12;

export class Crane {
  private readonly bounds: CraneBounds;
  private px: number;
  private py: number;
  private vx = 0;
  private vy = 0;
  private tx: number;
  private ty: number;

  constructor(bounds: CraneBounds, start: { x: number; y: number }) {
    this.bounds = bounds;
    this.px = this.clampX(start.x);
    this.py = this.clampY(start.y);
    this.tx = this.px;
    this.ty = this.py;
  }

  get pos(): { x: number; y: number } {
    return { x: this.px, y: this.py };
  }

  /** Whether the head has reached its commanded target and effectively stopped. */
  get arrived(): boolean {
    return (
      Math.abs(this.px - this.tx) <= ARRIVE_DIST &&
      Math.abs(this.py - this.ty) <= ARRIVE_DIST &&
      Math.hypot(this.vx, this.vy) <= ARRIVE_SPEED
    );
  }

  /** Command the head to a world point, clamped to the physical travel limits. */
  moveTo(x: number, y: number): void {
    this.tx = this.clampX(x);
    this.ty = this.clampY(y);
  }

  step(dtS: number): void {
    const [px, vx] = solveAxis(this.px, this.vx, this.tx, dtS);
    const [py, vy] = solveAxis(this.py, this.vy, this.ty, dtS);
    this.px = px;
    this.vx = vx;
    this.py = py;
    this.vy = vy;
  }

  private clampX(x: number): number {
    return Math.max(this.bounds.minX, Math.min(this.bounds.maxX, x));
  }
  private clampY(y: number): number {
    return Math.max(this.bounds.minY, Math.min(this.bounds.maxY, y));
  }
}

/** One axis of trapezoidal point-to-point motion: accelerate toward the target,
 *  cap at top speed, brake so the head comes to rest on it (never overshoots). */
function solveAxis(pos: number, vel: number, target: number, dtS: number): [number, number] {
  const d = target - pos;
  if (Math.abs(d) <= ARRIVE_DIST && Math.abs(vel) <= ARRIVE_SPEED) return [target, 0];

  const stopDist = (vel * vel) / (2 * ACCEL);
  let accel: number;
  if (vel !== 0 && Math.sign(d) !== Math.sign(vel)) {
    accel = -Math.sign(vel) * ACCEL; // moving the wrong way → brake
  } else if (Math.abs(d) <= stopDist) {
    accel = -Math.sign(vel) * ACCEL; // close enough that we must brake to stop on target
  } else {
    accel = Math.sign(d) * ACCEL; // open track → accelerate toward target
  }

  let nv = vel + accel * dtS;
  nv = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, nv));
  let np = pos + nv * dtS;
  /* Don't sail past the target within a step — snap and kill velocity. */
  if (Math.sign(target - np) !== Math.sign(d) && d !== 0) {
    np = target;
    nv = 0;
  }
  return [np, nv];
}
