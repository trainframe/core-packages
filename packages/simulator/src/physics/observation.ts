/**
 * The neutral DATA SHAPES at the device↔simulator seam: a motor command vocabulary
 * (`Motion`) and the observable pose of a body (`BodyPose` / `BodyKind`). These are
 * plain data — NOT the simulator. A world-agnostic device may know this vocabulary
 * (it is what an actuator accepts and what a camera reports) without ever depending
 * on the simulation that produces it, so these live apart from `world.ts` (which a
 * device must never import). `world.ts` re-exports them for its own consumers.
 */

/** A motor command — the only motion vocabulary a loco device has (ADR-030: a real
 *  loco knows its motor state, not its speed or position). */
export type Motion = 'forward' | 'stopped' | 'reverse';

/** What a body is, for rendering + observation. */
export type BodyKind = 'loco' | 'carriage';

/** A body's observable pose — what a camera/observer reports about it. */
export interface BodyPose {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly rotationDeg: number;
  readonly kind: BodyKind;
  readonly color: string | undefined;
  readonly mode: 'railed' | 'free';
  readonly fate: 'on-rail' | 'derailed' | 'ran-off';
  readonly speed: number;
  readonly coupledTo: readonly string[];
  /** The network segment the body is on (`main` for a single rail). */
  readonly segment: string;
}
