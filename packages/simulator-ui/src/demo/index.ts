/**
 * Public entry for the demo layouts, so other workspace packages (notably the
 * headless `@trainframe/integration` tests) can build the demo's compiled layout
 * without reaching into a deep source path. Pure data + geometry — no React, no
 * DOM — so it is safe to import from a Node test runner.
 */
export { buildRailyardDemo } from './railyard-demo.js';
export type { DemoCarriage, DemoTrain, RailyardDemo } from './railyard-demo.js';

/* The branching demo (FROZEN SPEC) — driven by the REAL scheduler. The headless
 * integration gate and the render script build the SAME assembly through this
 * composition root, varying only the device transport. */
export { buildBranchingDemo } from './branching-demo.js';
export type { BranchingDemo, DemoRoute, PlatformFactory } from './branching-demo.js';
export { buildBranchingScene } from '../physics/branching-scene.js';
export type { BranchingScene, SceneMarker } from '../physics/branching-scene.js';
export { sceneToLayout, markerAt, edgeRequiresSwitch } from '../physics/scene-markers.js';
export { PhysicsWorld } from '../physics/world.js';
export { mqttPlatform } from '../broker/mqtt-platform.js';
export { MqttBrokerClient } from '../broker/mqtt-client.js';
export type { BrokerClient } from '../broker/client.js';
