/**
 * Sim-backed `MotorActuator` (ADR-030/031): binds the device-side motor interface
 * to the simulator. This is sim-wiring, NOT device logic — the only layer
 * permitted to touch the world. The device receives the `MotorActuator` and never
 * knows a world exists.
 */
import type { MotorActuator } from '../devices/motor-actuator.js';
import type { Motion } from '../physics/observation.js';
import type { PhysicsWorld } from '../physics/world.js';

/** A sim-backed motor actuator: sets the body's motion intent on the world, which
 *  then integrates the actual velocity (under load, gravity, drag). */
export function physicsMotorActuator(world: PhysicsWorld, bodyId: string): MotorActuator {
  return {
    set(motion: Motion): void {
      world.setMotion(bodyId, motion);
    },
  };
}
