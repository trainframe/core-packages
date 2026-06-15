/**
 * Sim-backed `SwitchActuator` (ADR-030/031): binds the device-side switch
 * interface to the simulator's switch table. This is sim-wiring, NOT device logic
 * — it is the only layer permitted to touch the world. The device receives the
 * resulting `SwitchActuator` and never knows a world exists.
 */
import type { SwitchActuator } from '../devices/switch-actuator.js';
import type { PhysicsWorld } from '../physics/world.js';

/** A sim-backed switch actuator: sets the junction position on the world, which
 *  the rail network then consults at transitions. */
export function physicsSwitchActuator(world: PhysicsWorld, switchId: string): SwitchActuator {
  return {
    set(position: string): void {
      world.setSwitch(switchId, position);
    },
  };
}
