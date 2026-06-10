import type { LayoutState } from './layout-state.js';
import type { EdgeRef } from './types.js';

/**
 * Compute a transit — an ordered list of edges — from `fromMarker` to
 * `toMarker` through the static layout graph. Plain Dijkstra: cost is each
 * edge's `estimated_length_mm` (or `1` for edges without a length), and the
 * graph is the layout's marker→outgoing-edges map.
 *
 * The planner is **purely structural**: it looks only at the layout's static
 * topology. It does not consider current clearance holds, switch positions,
 * or any other runtime state. Two trains on a single-loop layout will share
 * identical transits and rely on the existing clearance/section-exclusivity
 * machinery to space themselves — see ADR-010.
 *
 * ## Directionality
 * Layout edges are bidirectional (every connection compiles to A→B *and* B→A),
 * but a moving train has a HEADING and must not flip 180° to take a shortcut —
 * reversal is a special-circumstance operation gated behind `grant_reverse`
 * (zone shunting, deadlock-breaking), never something ordinary routing does.
 * When the caller passes the train's `currentEdge`, the planner keeps the route
 * directional:
 *   - mid-edge (the train is committed to A→B, heading B): the route's first
 *     step is forced to be A→B, then plans onward forbidding the immediate
 *     U-turn B→A;
 *   - at a marker it just arrived on via A→B: the first step may not reverse
 *     back to A.
 * A target reachable only by reversing therefore yields `null` (the scheduler
 * surfaces it / the train parks) rather than a silent 180° flip.
 *
 * Returns:
 *   - The transit, when a path exists. An empty array means `fromMarker ===
 *     toMarker` (the train is already at the target stop; the scheduler
 *     handles that case).
 *   - `null` when the target is structurally unreachable from the source
 *     (in the train's permitted direction).
 */
interface FrontierEntry {
  readonly marker: string;
  readonly cost: number;
}

export function planTransit(
  layout: LayoutState,
  fromMarker: string,
  toMarker: string,
  currentEdge?: EdgeRef | undefined,
): ReadonlyArray<EdgeRef> | null {
  if (!layout.hasMarker(fromMarker) || !layout.hasMarker(toMarker)) return null;
  if (fromMarker === toMarker) return [];

  // Mid-edge: the train occupies A→B heading toward B, so the route MUST
  // continue along it — never reverse off it.
  if (currentEdge?.from_marker_id === fromMarker && currentEdge.to_marker_id !== fromMarker) {
    return planContinuing(layout, fromMarker, currentEdge.to_marker_id, toMarker);
  }
  // Stopped AT the to-marker of the edge it arrived on: it may leave any way
  // EXCEPT straight back the way it came (no 180° flip at a standstill) — and,
  // if this marker is a turnout, not across to another leg (it arrived via
  // `currentEdge.from`, so that side is the turnout entry).
  if (currentEdge?.to_marker_id === fromMarker && currentEdge.from_marker_id !== fromMarker) {
    return dijkstra(
      layout,
      fromMarker,
      toMarker,
      { from_marker_id: fromMarker, to_marker_id: currentEdge.from_marker_id },
      currentEdge.from_marker_id,
    );
  }
  return dijkstra(layout, fromMarker, toMarker, undefined, undefined);
}

/**
 * A turnout (a junction, or the experimental turntable) joins its TRUNK to each
 * switched LEG, but the legs do not join one another. So a train may not cross
 * from one leg to another *through* the junction — that is a physically
 * impossible exit-to-exit move (it reads as the train "reversing" at the
 * junction). Every legal move uses the trunk on at least one side.
 *
 * A neighbour is a switched leg iff the outbound edge junction→neighbour carries
 * a `requires_switch_state`. On plain (non-turnout) track no edge is switched,
 * so neither side is ever a leg and this rule never bites.
 */
function isSwitchedLeg(layout: LayoutState, marker: string, neighbour: string): boolean {
  return layout
    .edgesFrom(marker)
    .some((e) => e.to_marker_id === neighbour && e.requires_switch_state !== undefined);
}

function isLegToLegMove(
  layout: LayoutState,
  marker: string,
  arrivedFrom: string | undefined,
  toMarker: string,
): boolean {
  if (arrivedFrom === undefined) return false;
  return isSwitchedLeg(layout, marker, arrivedFrom) && isSwitchedLeg(layout, marker, toMarker);
}

/** Plan a route that is FORCED to leave `fromMarker` along its current edge
 *  (`fromMarker → continueTo`), then continues to `toMarker` without an
 *  immediate U-turn back. Returns null if the target isn't reachable that way. */
function planContinuing(
  layout: LayoutState,
  fromMarker: string,
  continueTo: string,
  toMarker: string,
): ReadonlyArray<EdgeRef> | null {
  const head: EdgeRef = { from_marker_id: fromMarker, to_marker_id: continueTo };
  if (continueTo === toMarker) return [head];
  if (!layout.hasMarker(continueTo)) return null;
  // The train arrives at `continueTo` from `fromMarker`; bar the U-turn back,
  // and (if `continueTo` is a turnout reached via a leg) the leg-to-leg cross.
  const rest = dijkstra(
    layout,
    continueTo,
    toMarker,
    { from_marker_id: continueTo, to_marker_id: fromMarker },
    fromMarker,
  );
  return rest === null ? null : [head, ...rest];
}

/**
 * Plain Dijkstra from `fromMarker` to `toMarker`, optionally refusing a single
 * `forbidEdge` (used to bar an immediate U-turn). `forbidEdge`'s `from` is
 * always the source, which a simple shortest path only ever leaves once, so
 * barring it globally bars exactly the first step.
 */
function dijkstra(
  layout: LayoutState,
  fromMarker: string,
  toMarker: string,
  forbidEdge: EdgeRef | undefined,
  startArrivedFrom: string | undefined,
): ReadonlyArray<EdgeRef> | null {
  if (fromMarker === toMarker) return [];
  const bestCost = new Map<string, number>([[fromMarker, 0]]);
  const cameFrom = new Map<string, { fromMarkerId: string; edge: EdgeRef }>();
  const frontier: FrontierEntry[] = [{ marker: fromMarker, cost: 0 }];

  while (frontier.length > 0) {
    const current = popLowestCost(frontier);
    if (!current) break;
    if (isStale(current, bestCost)) continue;
    if (current.marker === toMarker) {
      return reconstructTransit(cameFrom, fromMarker, toMarker);
    }
    relaxNeighbours(layout, current, bestCost, cameFrom, frontier, forbidEdge, startArrivedFrom);
  }

  return null;
}

/**
 * Smallest-cost-first removal from the frontier. The frontier stays tiny on
 * any realistic layout, so an O(n) min-scan beats the constant overhead of
 * a heap. Swap to a proper priority queue if profiles ever justify it.
 */
function popLowestCost(frontier: FrontierEntry[]): FrontierEntry | undefined {
  let bestIdx = 0;
  for (let i = 1; i < frontier.length; i++) {
    const candidate = frontier[i];
    const incumbent = frontier[bestIdx];
    if (candidate && incumbent && candidate.cost < incumbent.cost) bestIdx = i;
  }
  return frontier.splice(bestIdx, 1)[0];
}

function isStale(entry: FrontierEntry, bestCost: Map<string, number>): boolean {
  const settled = bestCost.get(entry.marker);
  return settled !== undefined && entry.cost > settled;
}

function relaxNeighbours(
  layout: LayoutState,
  current: FrontierEntry,
  bestCost: Map<string, number>,
  cameFrom: Map<string, { fromMarkerId: string; edge: EdgeRef }>,
  frontier: FrontierEntry[],
  forbidEdge: EdgeRef | undefined,
  startArrivedFrom: string | undefined,
): void {
  // How we reached this marker: its predecessor in the search, or — at the
  // start node, which has no predecessor — the heading the caller seeded. Used
  // to bar leg-to-leg moves through a turnout.
  const arrivedFrom = cameFrom.get(current.marker)?.fromMarkerId ?? startArrivedFrom;
  for (const edge of layout.edgesFrom(current.marker)) {
    if (
      forbidEdge !== undefined &&
      edge.from_marker_id === forbidEdge.from_marker_id &&
      edge.to_marker_id === forbidEdge.to_marker_id
    ) {
      continue;
    }
    if (isLegToLegMove(layout, current.marker, arrivedFrom, edge.to_marker_id)) continue;
    const stepCost = edge.estimated_length_mm ?? 1;
    const nextCost = current.cost + stepCost;
    const known = bestCost.get(edge.to_marker_id);
    if (known !== undefined && nextCost >= known) continue;
    bestCost.set(edge.to_marker_id, nextCost);
    cameFrom.set(edge.to_marker_id, {
      fromMarkerId: current.marker,
      edge: { from_marker_id: edge.from_marker_id, to_marker_id: edge.to_marker_id },
    });
    frontier.push({ marker: edge.to_marker_id, cost: nextCost });
  }
}

function reconstructTransit(
  cameFrom: Map<string, { fromMarkerId: string; edge: EdgeRef }>,
  fromMarker: string,
  toMarker: string,
): ReadonlyArray<EdgeRef> {
  const reversed: EdgeRef[] = [];
  let cursor = toMarker;
  while (cursor !== fromMarker) {
    const step = cameFrom.get(cursor);
    if (!step) {
      // Defensive — reconstruct should only run after we popped `toMarker`
      // with a complete predecessor chain. If we hit this, the planner's
      // book-keeping has gone wrong.
      throw new Error(`planner: missing predecessor for ${cursor}`);
    }
    reversed.push(step.edge);
    cursor = step.fromMarkerId;
  }
  return reversed.reverse();
}
