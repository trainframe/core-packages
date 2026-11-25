/**
 * The SPARSE marker-layer shape + protocol-`Layout` compiler for a piece-built scene: it
 * projects the opaque `RailNetwork` onto the few logical markers, junctions and directed
 * edges the scheduler reasons about. Markers sit where the scheduler needs a decision or
 * a clearance boundary, not one per piece.
 *
 * Pure: marker world positions come from `rail.at` only; no clock, no RNG.
 */
import type { Layout, LayoutEdge, LayoutJunction, LayoutMarker } from '@trainframe/protocol';
import type { SceneJunction, SceneMarker } from './markers.js';
import type { RailNetwork } from './network.js';

/** The sparse marker layer for a railyard scene: markers, the one core junction
 *  (the passing loop), the directed edge cycle, and the yard's throat marker. */
export interface RailyardMarkerLayer {
  readonly markers: readonly SceneMarker[];
  readonly junctions: readonly SceneJunction[];
  readonly edges: readonly EdgeSpec[];
  readonly throatMarker: string;
}

/** A directed core edge between two markers; `requiresSwitch` is the position the
 *  passing-loop switch must hold for this edge (only on edges out of `M-passing`). */
export interface EdgeSpec {
  readonly from: string;
  readonly to: string;
  readonly requiresSwitch?: string;
}

/** A marker's world position (x_mm, y_mm), from its anchor segment's rail. */
function markerPosition(net: RailNetwork, m: SceneMarker): { x_mm: number; y_mm: number } {
  const rail = net.railOf(m.segment);
  const d = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
  const p = rail.at(d);
  return { x_mm: Math.round(p.x), y_mm: Math.round(p.y) };
}

/** The rail length (mm) backing an edge, for `estimated_length_mm`: the anchor
 *  segment of its `from` marker — good enough for the in-sim driver's pacing. */
function edgeLengthMm(net: RailNetwork, layer: RailyardMarkerLayer, from: string): number {
  const m = layer.markers.find((mk) => mk.id === from);
  if (m === undefined) return 0;
  return Math.round(net.railOf(m.segment).length);
}

function compileMarkers(net: RailNetwork, layer: RailyardMarkerLayer): LayoutMarker[] {
  return layer.markers.map((m) => ({ id: m.id, kind: m.kind, position: markerPosition(net, m) }));
}

function compileEdges(net: RailNetwork, layer: RailyardMarkerLayer): LayoutEdge[] {
  return layer.edges.map((e) => {
    const edge: LayoutEdge = {
      from_marker_id: e.from,
      to_marker_id: e.to,
      estimated_length_mm: edgeLengthMm(net, layer, e.from),
    };
    return e.requiresSwitch !== undefined
      ? { ...edge, requires_switch_state: e.requiresSwitch }
      : edge;
  });
}

function compileJunctions(layer: RailyardMarkerLayer): LayoutJunction[] {
  return layer.junctions.map((j) => ({ marker_id: j.markerId, valid_positions: [...j.positions] }));
}

/** Compile a railyard marker layer into a protocol `Layout` (markers positioned
 *  from the rail, the directed edge cycle, the passing-loop junction). */
export function railyardToLayout(
  net: RailNetwork,
  layer: RailyardMarkerLayer,
  name: string,
): Layout {
  return {
    name,
    markers: compileMarkers(net, layer),
    edges: compileEdges(net, layer),
    junctions: compileJunctions(layer),
  };
}
