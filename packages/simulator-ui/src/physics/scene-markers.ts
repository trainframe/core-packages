/**
 * The marker↔segment map and the protocol-`Layout` compiler for a
 * `BranchingScene` (FROZEN SPEC §2). This is the physics analog of
 * `layout-from-pieces.ts:compileLayout` — it projects the opaque physics
 * `RailNetwork` onto the logical marker graph the scheduler reasons about.
 *
 * Pure: marker world positions come from `rail.at` only; no clock, no RNG. The
 * yard interior is OPAQUE — its segments produce no markers or edges; core sees
 * the yard as `M-yard-throat` (boundary) → `M-yard-far` (far side) only.
 */
import type { Layout, LayoutEdge, LayoutJunction, LayoutMarker } from '@trainframe/protocol';
import type { BranchingScene, MarkerEnd, SceneMarker } from './branching-scene.js';

/** The marker (if any) anchored at `segment`'s `end`. Round-trips the scene's
 *  marker model: `markerAt(scene, m.segment, m.end) === m.id` for every
 *  end-anchored marker. Mid-segment (`distAlongMm`) markers are NOT end-anchored
 *  and so are intentionally not returned here. */
export function markerAt(
  scene: BranchingScene,
  segment: string,
  end: MarkerEnd,
): string | undefined {
  for (const m of scene.markers) {
    if (m.distAlongMm !== undefined) continue;
    if (m.segment === segment && m.end === end) return m.id;
  }
  return undefined;
}

/** The world position (x_mm, y_mm) of a marker, from its anchor segment's rail. */
function markerPosition(scene: BranchingScene, m: SceneMarker): { x_mm: number; y_mm: number } {
  const rail = scene.net.railOf(m.segment);
  const d = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
  const p = rail.at(d);
  return { x_mm: Math.round(p.x), y_mm: Math.round(p.y) };
}

/**
 * The switch + position a route edge `fromMarker → toMarker` requires, or
 * undefined for an unswitched joint. Mirrors `switchStateForEndpoint`: a
 * junction-crossing edge carries the `when.position` of the physics link the
 * train will take. Derived from the scene's declared junctions + the known
 * branch topology so it stays consistent with `buildBranchingScene`.
 */
export function edgeRequiresSwitch(
  scene: BranchingScene,
  fromMarker: string,
  toMarker: string,
): { switchId: string; position: string } | undefined {
  for (const j of scene.junctions) {
    if (j.markerId !== fromMarker) continue;
    const diverge = DIVERGE_EDGES[`${fromMarker}->${toMarker}`];
    if (diverge !== undefined) return { switchId: j.switchId, position: diverge };
    const thru = THRU_POSITION[j.switchId];
    if (thru !== undefined) return { switchId: j.switchId, position: thru };
  }
  return undefined;
}

/* The diverging (non-`thru`) position each junction edge selects. The remaining
 * edge out of a junction takes the junction's `thru` position. */
const DIVERGE_EDGES: Readonly<Record<string, string>> = {
  'M-main-w->M-yard-throat': 'yard',
  'M-spur->M-branch-top': 'branch',
};
const THRU_POSITION: Readonly<Record<string, string>> = {
  Jloop: 'thru',
  Jspur: 'thru',
};

/** The directed core edges of the branching layout — the marker adjacency along
 *  the rail network, forming cycles (main loop, branch loop, yard branch). The
 *  yard interior is opaque: the only yard edges are throat→far and far→throat. */
const CORE_EDGES: ReadonlyArray<readonly [string, string]> = [
  /* Main loop cycle. */
  ['M-top', 'M-main-w'],
  ['M-main-w', 'M-main-wlow'],
  ['M-main-wlow', 'M-central'],
  ['M-central', 'M-main-e'],
  ['M-main-e', 'M-spur'],
  ['M-spur', 'M-top'],
  /* Yard branch (off `Jloop=yard`), opaque interior. */
  ['M-main-w', 'M-yard-throat'],
  ['M-yard-throat', 'M-yard-far'],
  ['M-yard-far', 'M-main-e'],
  /* Branch loop (off `Jspur=branch`), rejoining the main top straight. */
  ['M-spur', 'M-branch-top'],
  ['M-branch-top', 'M-branch-bot'],
  ['M-branch-bot', 'M-top'],
];

/** The rail length (mm) backing a core edge, for `estimated_length_mm`. Opaque
 *  yard edges use the throat/far lead lengths; everything else is the anchor
 *  segment of the `from` marker (a good-enough estimate for the in-sim driver). */
function edgeLengthMm(scene: BranchingScene, from: string, to: string): number {
  const fromMarker = scene.markers.find((m) => m.id === from);
  const seg = SEGMENT_FOR_EDGE[`${from}->${to}`] ?? fromMarker?.segment;
  if (seg === undefined) return 0;
  return Math.round(scene.net.railOf(seg).length);
}

/* Edges whose backing length is best read off a specific segment (the opaque
 * yard span + the branch return), not the `from` marker's anchor segment. */
const SEGMENT_FOR_EDGE: Readonly<Record<string, string>> = {
  'M-yard-throat->M-yard-far': 'thru',
  'M-branch-bot->M-top': 'bBottom',
  'M-yard-far->M-main-e': 'connOut',
};

function compileMarkers(scene: BranchingScene): LayoutMarker[] {
  return scene.markers.map((m) => ({
    id: m.id,
    kind: m.kind,
    position: markerPosition(scene, m),
  }));
}

function compileEdges(scene: BranchingScene): LayoutEdge[] {
  return CORE_EDGES.map(([from, to]) => {
    const edge: LayoutEdge = {
      from_marker_id: from,
      to_marker_id: to,
      estimated_length_mm: edgeLengthMm(scene, from, to),
    };
    const sw = edgeRequiresSwitch(scene, from, to);
    return sw !== undefined ? { ...edge, requires_switch_state: sw.position } : edge;
  });
}

function compileJunctions(scene: BranchingScene): LayoutJunction[] {
  return scene.junctions.map((j) => ({
    marker_id: j.markerId,
    valid_positions: [...j.positions],
  }));
}

/**
 * Compile a `BranchingScene` into a protocol `Layout`:
 *  - `markers[]`: one per `SceneMarker`, position from the anchor rail.
 *  - `edges[]`: the directed marker adjacency along the rail network (cycles).
 *    Junction-crossing edges carry `requires_switch_state`. Yard interior emits
 *    none — the yard view is `M-yard-throat` ↔ `M-yard-far` only.
 *  - `junctions[]`: one per `SceneJunction` with `valid_positions`.
 */
export function sceneToLayout(scene: BranchingScene, name: string): Layout {
  return {
    name,
    markers: compileMarkers(scene),
    edges: compileEdges(scene),
    junctions: compileJunctions(scene),
  };
}
