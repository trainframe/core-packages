/**
 * The payload seam shared by every crane (ADR-031 §2). A crane — whatever its
 * mechanism (a Cartesian XY gantry, a slewing jib) — presents the same honest
 * actuator surface: it carries a hook that is somewhere in the world (`pos`),
 * may or may not be carrying a payload (`carrying`), takes real time to reach a
 * commanded target (`arrived`), and is integrated over a virtual clock by
 * `step(dt)`. The controller commands intent (a `moveTo`/`aimAt` on the concrete
 * crane) and then awaits arrival; it never animates the motion or reads the
 * world's ground truth.
 *
 * `grab`/`release` are the cargo latch: `grab` latches a payload onto the hook,
 * `release` lets it go and reports whether the hook WAS carrying (so the caller
 * knows to drop a real body into the simulator at `pos`).
 *
 * Concrete cranes (`Crane` — the gantry; `JibCrane` — the dock jib) add their
 * own targeting commands on top of this; this interface is only the common seam
 * a render layer or a controller can lean on without caring which crane it is.
 */
export interface PayloadCrane {
  /** The hook's current world position (mm). */
  readonly pos: { readonly x: number; readonly y: number };
  /** Whether the hook is currently carrying a payload. */
  readonly carrying: boolean;
  /** Whether the hook has reached its commanded target and effectively stopped. */
  readonly arrived: boolean;
  /** Latch a payload onto the hook. */
  grab(): void;
  /** Let the payload go; returns true if it WAS carrying (caller drops a body). */
  release(): boolean;
  /** Integrate the actuator(s) forward by `dtS` seconds over the virtual clock. */
  step(dtS: number): void;
}
