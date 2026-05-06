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

export const PRESET_LAYOUTS = {
  'simple-loop': SIMPLE_LOOP,
} as const;

export type PresetLayoutId = keyof typeof PRESET_LAYOUTS;
