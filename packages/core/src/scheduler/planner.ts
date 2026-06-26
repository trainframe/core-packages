import type { LayoutState } from './layout-state.js';
import type { EdgeRef } from './types.js';

/**
 * A search state is a marker PLUS the marker we arrived from — not the marker
 * alone. At a turnout the set of legal exits depends on how the train entered
 * it (the leg-to-leg bar), so the same marker reached via two different
 * neighbours is two distinct states with different onward moves. Keying the
 * search by marker alone lets the cheapest arrival settle a junction and bar
 * an exit a costlier arrival would have allowed — silently dropping a route
 * that exists (a train "stuck" at a junction rather than routing round).
 */
interface FrontierEntry {
  readonly marker: string;
  readonly arrivedFrom: string | undefined;
  readonly cost: number;
}

/** State identity for the augmented search: marker + arrival direction. */
function stateKey(marker: string, arrivedFrom: string | undefined): string {
  return `${arrivedFrom ?? ''}>${marker}`;
}

/**
 * Compute a transit — an ordered list of edges — from `fromMarker` to
 * `toMarker` through the static layout graph. Dijkstra over
 * (marker, arrival-direction) states: cost is each edge's `estimated_length_mm`
 * (or `1` for edges without a length), and the graph is the layout's
 * marker→outgoing-edges map.
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
    return dijkstra(layout, fromMarker, toMarker, currentEdge.from_marker_id);
  }
  return dijkstra(layout, fromMarker, toMarker, undefined);
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
  const rest = dijkstra(layout, continueTo, toMarker, fromMarker);
  return rest === null ? null : [head, ...rest];
}

/**
 * Dijkstra over (marker, arrival-direction) states from `fromMarker` to
 * `toMarker`. `startArrivedFrom` seeds the heading the caller is committed to:
 * the search will not reverse straight back onto it (nor, at a turnout, cross
 * leg-to-leg through it). Pass `undefined` for a standing train with no
 * heading — then any initial direction is allowed.
 */
function dijkstra(
  layout: LayoutState,
  fromMarker: string,
  toMarker: string,
  startArrivedFrom: string | undefined,
): ReadonlyArray<EdgeRef> | null {
  if (fromMarker === toMarker) return [];
  const startKey = stateKey(fromMarker, startArrivedFrom);
  const bestCost = new Map<string, number>([[startKey, 0]]);
  const cameFrom = new Map<string, { fromKey: string; edge: EdgeRef }>();
  const frontier: FrontierEntry[] = [
    { marker: fromMarker, arrivedFrom: startArrivedFrom, cost: 0 },
  ];

  while (frontier.length > 0) {
    const current = popLowestCost(frontier);
    if (!current) break;
    if (isStale(current, bestCost)) continue;
    if (current.marker === toMarker) {
      return reconstructTransit(cameFrom, startKey, current);
    }
    relaxNeighbours(layout, current, bestCost, cameFrom, frontier);
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
  const settled = bestCost.get(stateKey(entry.marker, entry.arrivedFrom));
  return settled !== undefined && entry.cost > settled;
}

function relaxNeighbours(
  layout: LayoutState,
  current: FrontierEntry,
  bestCost: Map<string, number>,
  cameFrom: Map<string, { fromKey: string; edge: EdgeRef }>,
  frontier: FrontierEntry[],
): void {
  // How we reached this marker is carried IN the search state, so the leg-to-leg
  // bar reflects this exact arrival — not whichever arrival happened to settle
  // the marker first.
  const arrivedFrom = current.arrivedFrom;
  const fromKey = stateKey(current.marker, arrivedFrom);
  for (const edge of layout.edgesFrom(current.marker)) {
    // No immediate U-turn: a train with a heading never reverses straight back
    // onto the edge it just arrived on. (A standing train — arrivedFrom
    // undefined — has no heading to reverse, so this never bites the start.)
    if (edge.to_marker_id === arrivedFrom) continue;
    if (isLegToLegMove(layout, current.marker, arrivedFrom, edge.to_marker_id)) continue;
    const stepCost = edge.estimated_length_mm ?? 1;
    const nextCost = current.cost + stepCost;
    const nextKey = stateKey(edge.to_marker_id, current.marker);
    const known = bestCost.get(nextKey);
    if (known !== undefined && nextCost >= known) continue;
    bestCost.set(nextKey, nextCost);
    cameFrom.set(nextKey, {
      fromKey,
      edge: { from_marker_id: edge.from_marker_id, to_marker_id: edge.to_marker_id },
    });
    frontier.push({ marker: edge.to_marker_id, arrivedFrom: current.marker, cost: nextCost });
  }
}

function reconstructTransit(
  cameFrom: Map<string, { fromKey: string; edge: EdgeRef }>,
  startKey: string,
  goal: FrontierEntry,
): ReadonlyArray<EdgeRef> {
  const reversed: EdgeRef[] = [];
  let cursor = stateKey(goal.marker, goal.arrivedFrom);
  while (cursor !== startKey) {
    const step = cameFrom.get(cursor);
    if (!step) {
      // Defensive — reconstruct should only run after we popped the goal state
      // with a complete predecessor chain. If we hit this, the planner's
      // book-keeping has gone wrong.
      throw new Error(`planner: missing predecessor for ${cursor}`);
    }
    reversed.push(step.edge);
    cursor = step.fromKey;
  }
  return reversed.reverse();
}
