/**
 * Trainframe Compact Frame (TCF) — the ESP-NOW link-layer wire format and its
 * lossless codec to/from the canonical JSON application envelope (ADR-021).
 *
 * Pure data transformation only: no I/O, no clock, no UUID generation inside
 * the codec. Lives in `@trainframe/protocol` because it is a pure wire-shape
 * concern (alongside schemas, topic helpers). See codec.ts for the ADR-vs-
 * placement note.
 */
export * from './registry.js';
export * from './codec.js';
