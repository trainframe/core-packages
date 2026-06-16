/**
 * A junction-switch actuator — an ActuatorProvider (ADR-030 §2). A device that
 * owns junctions (the railyard, throwing its ladder taps) commands a switch to a
 * named position through this interface and nothing more. The sim-backed
 * implementation lives in `sim/`; on real hardware the same interface drives a
 * points motor. The device is agnostic to which.
 */

/** A swappable junction switch. The device throws points ONLY through this. */
export interface SwitchActuator {
  /** Throw the switch to a named position (e.g. 'through' / 'branch'). */
  set(position: string): void;
}
