/**
 * The SPARSE marker layer + protocol-`Layout` compiler for the real-piece railyard
 * (`buildFullRailyardScene`). The physics analog of `scene-markers.ts`, but for the
 * piece-built network: it projects the opaque `RailNetwork` onto the few logical
 * markers the scheduler reasons about.
 *
 * Markers are SPARSE and named only for the demo — not one per piece. They sit
 * where the scheduler genuinely needs a decision or a clearance boundary:
 *   - the passing-loop facing turnout (a `junction` marker, paired to its switch),
 *   - the siding's block boundary (so the loop is a distinct route, not a parallel
 *     edge — the diamond M-passing → {main | M-loop} → M-central),
 *   - the two STATIONS operators actually route between (`M-central`, `M-north`),
 *   - the yard throat (`yard_entry` boundary — the gates_zone admission point),
 *   - a block boundary at each end of the running line for clearance granularity.
 *
 * Operators route STATION → STATION; the marker names are an internal/demo concern,
 * never an operator one. The yard throat switch is OWNED by the yard device (not a
 * core junction): the running line passes through the yard on its spine by default,
 * so the throat → east edge is opaque (no `requires_switch_state`), exactly as the
 * in-line bezier yard was.
 *
 * Pure: marker world positions come from `rail.at` only; no clock, no RNG.
 */
import type { Layout, LayoutEdge, LayoutJunction, LayoutMarker } from '@trainframe/protocol';
import type { SceneJunction, SceneMarker } from './markers.js';
import type { RailNetwork } from './network.js';

/** The railyard's marker ids (internal/demo names — operators see only stations). */
export const RAILYARD_MARKERS = {
  west: 'M-west',
  passing: 'M-passing',
  loop: 'M-loop',
  central: 'M-central',
  throat: 'M-yard-throat',
  east: 'M-east',
  north: 'M-north',
} as const;

/** The running-line + branch segment ids a railyard scene must hand the marker
 *  layer to anchor its sparse markers (all known when the scene is assembled). */
export interface RailyardAnchors {
  /** Bottom lead-in run (trains seed here; west block boundary). */
  readonly westSeg: string;
  /** Bottom run between the passing loop and the yard (the `M-central` station). */
  readonly midSeg: string;
  /** Bottom lead-out run before the right U-turn (east block boundary). */
  readonly eastSeg: string;
  /** Top run on the far side (the `M-north` station). */
  readonly topSeg: string;
  /** Passing-loop inbound stub — its end is the facing turnout (`M-passing`). */
  readonly passingInbound: string;
  /** The siding run (`M-loop` block boundary, the diverted route). */
  readonly passingLoopSeg: string;
  /** The passing-loop switch the scheduler drives, and its two positions. */
  readonly passingSwitchId: string;
  readonly passingMainPos: string;
  readonly passingLoopPos: string;
  /** Yard inbound stub — its end is the throat (`M-yard-throat`). */
  readonly yardInbound: string;
}

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

/** Half-way along a segment's rail (mm) — where a station marker sits, centred. */
function midOf(net: RailNetwork, segment: string): number {
  return net.railOf(segment).length / 2;
}

/**
 * Build the sparse marker layer from a scene's anchor segments. The cycle runs
 * west → passing turnout → central station → yard throat → east → north station →
 * back. The passing loop is a diamond off `M-passing`: the main route goes
 * straight to `M-central`, the diverted route goes via `M-loop` (the siding) and
 * rejoins at `M-central`. The yard is opaque (throat → east carries no switch).
 */
export function buildRailyardMarkers(net: RailNetwork, a: RailyardAnchors): RailyardMarkerLayer {
  const M = RAILYARD_MARKERS;
  const markers: SceneMarker[] = [
    { id: M.west, segment: a.westSeg, end: 'start', kind: 'block_boundary' },
    { id: M.passing, segment: a.passingInbound, end: 'end', kind: 'junction' },
    {
      id: M.loop,
      segment: a.passingLoopSeg,
      end: 'start',
      distAlongMm: midOf(net, a.passingLoopSeg),
      kind: 'block_boundary',
    },
    {
      id: M.central,
      segment: a.midSeg,
      end: 'start',
      distAlongMm: midOf(net, a.midSeg),
      kind: 'station_stop',
    },
    { id: M.throat, segment: a.yardInbound, end: 'end', kind: 'yard_entry' },
    { id: M.east, segment: a.eastSeg, end: 'end', kind: 'block_boundary' },
    {
      id: M.north,
      segment: a.topSeg,
      end: 'start',
      distAlongMm: midOf(net, a.topSeg),
      kind: 'station_stop',
    },
  ];
  const junctions: SceneJunction[] = [
    {
      markerId: M.passing,
      switchId: a.passingSwitchId,
      positions: [a.passingMainPos, a.passingLoopPos],
    },
  ];
  const edges: EdgeSpec[] = [
    { from: M.west, to: M.passing },
    { from: M.passing, to: M.central, requiresSwitch: a.passingMainPos },
    { from: M.passing, to: M.loop, requiresSwitch: a.passingLoopPos },
    { from: M.loop, to: M.central },
    { from: M.central, to: M.throat },
    { from: M.throat, to: M.east },
    { from: M.east, to: M.north },
    { from: M.north, to: M.west },
  ];
  return { markers, junctions, edges, throatMarker: M.throat };
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
