export { Simulation } from './simulation.js';
export type {
  CapturedEvent,
  SimulationEventListener,
  SimulationOptions,
} from './simulation.js';
export { VirtualTrain, DEFAULT_TRAIN_CONFIG } from './virtual-train.js';
export type { VirtualTrainConfig, VirtualCarriage } from './virtual-train.js';
export { VirtualGate } from './virtual-gate.js';
export { VirtualRailyard } from './virtual-railyard.js';
export { VirtualSwitch } from './virtual-switch.js';
export { VirtualClock } from './clock.js';
export { SeededRandom } from './random.js';
export { BrokerBridge } from './broker-bridge.js';
export type { BrokerBridgeOptions, BrokerLike } from './broker-bridge.js';

/* The physics engine (ADR-030) now lives here — `@trainframe/simulator` is the real
 * simulator. This re-exports the demo/scene public surface (PhysicsWorld, the demo
 * assemblies, scene→layout compilers, the browser broker transport) that headless
 * integration tests and the simulator-ui rendering app build against. Deep engine
 * modules are reachable via subpath (`@trainframe/simulator/physics/world.js`). */
export * from './demo/index.js';
