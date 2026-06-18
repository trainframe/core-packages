/* `@trainframe/simulator` IS the ADR-030 physics engine. The old virtual-device
 * sim (Simulation / Virtual{Train,Gate,Railyard,Switch} / BrokerBridge / VirtualClock
 * / SeededRandom / startTestEnvironment) has been fully removed — physics is the
 * only simulator now.
 *
 * This barrel is the engine's public surface: the demo/scene assemblies, the
 * scene→layout compilers, the browser broker transport (re-exported from
 * `./demo/index.js`), plus the device + sensor + actuator primitives and the
 * `physics-env` test harness that headless integration tests and the ui-tests
 * harness build device layers from. Deep engine modules remain reachable via
 * subpath (`@trainframe/simulator/physics/world.js`). */
export * from './demo/index.js';

/* Device primitives (world-agnostic; bound to the world via the sim actuators). */
export { ScheduledTrainDevice } from './devices/scheduled-train-device.js';
export { SwitchDevice } from './devices/switch-device.js';
export { GateDevice } from './devices/gate-device.js';
export type { MarkerPoint } from './devices/marker-sensor.js';

/* Sim-wiring: bind a device's provider seams to a `PhysicsWorld`. */
export { physicsMarkerSensor } from './sim/marker-sensor.js';
export { physicsMotorActuator } from './sim/motor-actuator.js';
export { physicsSwitchActuator } from './sim/switch-actuator.js';

/* The physics test harness (replacement for the deleted `startTestEnvironment`). */
export { startPhysicsEnv, straightLoop } from './physics-env.js';
export type {
  LoopMarker,
  PhysicsEnv,
  PhysicsScene,
  SpawnGateOptions,
  SpawnSwitchOptions,
  SpawnTrainOptions,
} from './physics-env.js';
export type { RailNetwork } from './physics/network.js';
