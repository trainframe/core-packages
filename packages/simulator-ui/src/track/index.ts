/**
 * Public entry for the pure track-geometry + layout-compiler modules, so other
 * workspace packages (notably the headless `@trainframe/integration` tests) can
 * compile placed pieces into a `Layout` without a deep source path. Pure
 * geometry — no React, no DOM — so it is safe to import from a Node test runner.
 */
export { compileLayout, SNAP_DISTANCE } from './layout-from-pieces.js';
export { detectSameLayerOverlaps } from './overlap.js';
export type { TrackPiece, TrackPieceType } from './pieces.js';
