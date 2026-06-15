/**
 * The ActuatorProvider seam (ADR-030 §2) — the ACT half of a device's I/O, the
 * mirror of the CameraProvider's SENSE half.
 *
 * A motor actuator is the only way a train device commands movement: forward /
 * stop / reverse, nothing finer (a real loco knows its motor state, not its speed
 * or position — ADR-030's retcon). The sim-backed implementation lives in `sim/`;
 * on real hardware the same interface drives a motor controller / GPIO. The device
 * logic is agnostic to which.
 */
import type { Motion } from '../physics/observation.js';

/** A swappable motor. The train device acts ONLY through this. */
export interface MotorActuator {
  /** Command the motor state; the actuator's backing enacts it. */
  set(motion: Motion): void;
}
