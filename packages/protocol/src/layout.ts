import { type Static, Type } from '@sinclair/typebox';
import { Uuid } from './envelope.js';

const MarkerKind = Type.Union([
  Type.Literal('block_boundary'),
  Type.Literal('station_stop'),
  Type.Literal('junction'),
  Type.Literal('terminus'),
  Type.Literal('yard_entry'),
  Type.Literal('unspecified'),
]);

export const LayoutMarker = Type.Object({
  id: Uuid,
  kind: MarkerKind,
  /** Optional 2D position for the visualiser; ignored by the scheduler. */
  position: Type.Optional(
    Type.Object({
      x_mm: Type.Number(),
      y_mm: Type.Number(),
    }),
  ),
  /** Display label for the visualiser. */
  label: Type.Optional(Type.String()),
});

export const LayoutEdge = Type.Object({
  from_marker_id: Uuid,
  to_marker_id: Uuid,
  /** Required only if from_marker_id is a junction. */
  requires_switch_state: Type.Optional(Type.String()),
  /** Initially null; populated as the system learns. */
  estimated_length_mm: Type.Optional(Type.Number({ minimum: 0 })),
  /** Inferred edges have not been traversed enough to be confirmed. */
  inferred: Type.Optional(Type.Boolean()),
});

export const LayoutJunction = Type.Object({
  marker_id: Uuid,
  /**
   * The position labels valid for this junction. Defaults to ['main', 'diverge']
   * if omitted. Custom positions enable multi-way junctions.
   */
  valid_positions: Type.Optional(Type.Array(Type.String(), { minItems: 2 })),
  /** Initial switch state if known. */
  initial_state: Type.Optional(Type.String()),
});

export const Layout = Type.Object({
  name: Type.String(),
  markers: Type.Array(LayoutMarker),
  edges: Type.Array(LayoutEdge),
  junctions: Type.Array(LayoutJunction),
});

export type LayoutMarker = Static<typeof LayoutMarker>;
export type LayoutEdge = Static<typeof LayoutEdge>;
export type LayoutJunction = Static<typeof LayoutJunction>;
export type Layout = Static<typeof Layout>;
