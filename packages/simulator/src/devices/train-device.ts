/**
 * A train as a portable device (ADR-030 §1): a thin controller that knows only
 * its motion intent — forward / stopped / reverse — and acts on the world solely
 * through a `MotorActuator`. It holds NO geometry, NO velocity, NO position (a
 * real loco can't measure those — ADR-030's retcon); the simulator's physics
 * owns all of that and decides what actually happens (load, gravity, collisions).
 *
 * The same class would run on real hardware by swapping the actuator for a motor
 * driver. Here it is what the scenarios command, instead of poking the world.
 */
import type { Motion } from '../physics/observation.js';
import type { MotorActuator } from './motor-actuator.js';

export class TrainDevice {
  private readonly id: string;
  private readonly motor: MotorActuator;
  private intent: Motion = 'stopped';

  constructor(id: string, motor: MotorActuator) {
    this.id = id;
    this.motor = motor;
  }

  /** The device id (`T-<piece>` on the wire; bare here). */
  get deviceId(): string {
    return this.id;
  }

  /** The motor state the device is currently commanding. */
  get motion(): Motion {
    return this.intent;
  }

  /** Command the motor — the device's whole vocabulary. */
  drive(motion: Motion): void {
    this.intent = motion;
    this.motor.set(motion);
  }

  forward(): void {
    this.drive('forward');
  }
  stop(): void {
    this.drive('stopped');
  }
  reverse(): void {
    this.drive('reverse');
  }
}
