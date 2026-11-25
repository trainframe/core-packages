/**
 * Public entry for the demo layouts, so other workspace packages (notably the
 * headless `@trainframe/integration` tests) can build the demo's compiled layout
 * without reaching into a deep source path. Pure data + geometry — no React, no
 * DOM — so it is safe to import from a Node test runner.
 */
/* The interesting-railway demo — FOUR trains on the winding loop + drive-through yard,
 * driven by the REAL scheduler (the 4-train stress test). Its devices talk to core
 * through a `PlatformProvider` the caller supplies per device id. */
export type { PlatformFactory } from './interesting-railway-demo.js';
export {
  buildInterestingRailwayDemo,
  INTERESTING_YARD_DEVICE_ID,
} from './interesting-railway-demo.js';
export type { InterestingRailwayDemo } from './interesting-railway-demo.js';
export { buildMainLoopScene } from '../physics/interesting-layout.js';
export {
  interestingToLayout,
  buildInterestingMarkers,
  INTERESTING_MARKERS,
} from '../physics/interesting-markers.js';
export type { SceneMarker } from '../physics/markers.js';
export { PhysicsWorld } from '../physics/world.js';
export { mqttPlatform } from '../broker/mqtt-platform.js';
export { MqttBrokerClient } from '../broker/mqtt-client.js';
export type { BrokerClient } from '../broker/client.js';
