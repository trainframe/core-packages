import type { Layout } from '@trainframe/protocol';

/**
 * Preset layouts the simulator UI can run against. Marker IDs are short
 * strings (`M1`, `M2`, …) for readability — the protocol schemas declare
 * `format: 'uuid'` for marker IDs, but that's enforced at the broker
 * boundary, not in the in-process simulator. The visualiser parses
 * incoming events loosely.
 */

export const SIMPLE_LOOP: Layout = {
  name: 'simple-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
    { id: 'M4', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

/**
 * A six-marker loop with two stations. Same topology as SIMPLE_LOOP but longer,
 * useful for spacing trains out and seeing trailing clearance at work.
 */
export const LONG_LOOP: Layout = {
  name: 'long-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'station_stop' },
    { id: 'M3', kind: 'block_boundary' },
    { id: 'M4', kind: 'block_boundary' },
    { id: 'M5', kind: 'station_stop' },
    { id: 'M6', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M5', estimated_length_mm: 200 },
    { from_marker_id: 'M5', to_marker_id: 'M6', estimated_length_mm: 200 },
    { from_marker_id: 'M6', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

export const PRESET_LAYOUTS = {
  'simple-loop': SIMPLE_LOOP,
  'long-loop': LONG_LOOP,
} as const;

export type PresetLayoutId = keyof typeof PRESET_LAYOUTS;

export const PRESET_LAYOUT_IDS = Object.keys(PRESET_LAYOUTS) as PresetLayoutId[];

export function isPresetLayoutId(value: string): value is PresetLayoutId {
  return value in PRESET_LAYOUTS;
}
