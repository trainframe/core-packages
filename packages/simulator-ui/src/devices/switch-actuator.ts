/**
 * A junction-switch actuator — another ActuatorProvider (ADR-030 §2). A device
 * that owns junctions (the railyard, throwing its ladder taps) commands a switch
 * to a position; the sim-backed actuator sets it on the physics world's switch
 * table, which the rail network then consults at transitions. On real hardware
 * the same interface drives a points motor.
 */
import type { PhysicsWorld } from '../physics/world.js';

/** A swappable junction switch. The device throws points ONLY through this. */
export interface SwitchActuator {
  /** Throw the switch to a named position (e.g. 'through' / 'branch'). */
  set(position: string): void;
}

/** A sim-backed switch actuator: sets the junction position on the world. */
export function physicsSwitchActuator(world: PhysicsWorld, switchId: string): SwitchActuator {
  return {
    set(position: string): void {
      world.setSwitch(switchId, position);
    },
  };
}
