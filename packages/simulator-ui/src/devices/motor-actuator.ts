/**
 * The ActuatorProvider seam (ADR-030 §2) — the ACT half of a device's I/O, the
 * mirror of the CameraProvider's SENSE half.
 *
 * A motor actuator is the only way a train device makes the world move: it can
 * command forward / stop / reverse, nothing finer (a real loco knows its motor
 * state, not its speed or position — ADR-030's retcon). In the simulator the
 * actuator drives the authoritative `PhysicsWorld`; on real hardware the SAME
 * interface drives a motor controller / GPIO. The device logic never changes.
 */
import type { Motion, PhysicsWorld } from '../physics/world.js';

/** A swappable motor. The train device acts on the world ONLY through this. */
export interface MotorActuator {
  /** Command the motor state. The world (or real hardware) enacts it. */
  set(motion: Motion): void;
}

/** A sim-backed motor actuator: it sets the body's motion intent on the physics
 *  world, which then integrates the actual velocity (under load, gravity, drag). */
export function physicsMotorActuator(world: PhysicsWorld, bodyId: string): MotorActuator {
  return {
    set(motion: Motion): void {
      world.setMotion(bodyId, motion);
    },
  };
}
