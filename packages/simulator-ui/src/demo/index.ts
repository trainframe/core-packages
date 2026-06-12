/**
 * Public entry for the demo layouts, so other workspace packages (notably the
 * headless `@trainframe/integration` tests) can build the demo's compiled layout
 * without reaching into a deep source path. Pure data + geometry — no React, no
 * DOM — so it is safe to import from a Node test runner.
 */
export { buildRailyardDemo } from './railyard-demo.js';
export type { DemoCarriage, DemoTrain, RailyardDemo } from './railyard-demo.js';
