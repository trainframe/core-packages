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
 * Returns:
 *   - The transit, when a path exists. An empty array means `fromMarker ===
 *     toMarker` (the train is already at the target stop; the scheduler
 *     handles that case).
 *   - `null` when the target is structurally unreachable from the source.
 *     The scheduler turns this into an anomaly; a transit-less schedule
 *     leaves the train parked.
 */
interface FrontierEntry {
  readonly marker: string;
  readonly cost: number;
}

export function planTransit(
  layout: LayoutState,
  fromMarker: string,
  toMarker: string,
): ReadonlyArray<EdgeRef> | null {
  if (!layout.hasMarker(fromMarker) || !layout.hasMarker(toMarker)) return null;
  if (fromMarker === toMarker) return [];

  // Dijkstra. Frontier is sorted-by-cost; predecessors map lets us
  // reconstruct the path once we pop the target.
  const bestCost = new Map<string, number>();
  bestCost.set(fromMarker, 0);
  const cameFrom = new Map<string, { fromMarkerId: string; edge: EdgeRef }>();
  const frontier: FrontierEntry[] = [{ marker: fromMarker, cost: 0 }];

  while (frontier.length > 0) {
    const current = popLowestCost(frontier);
    if (!current) break;
    if (isStale(current, bestCost)) continue;
    if (current.marker === toMarker) {
      return reconstructTransit(cameFrom, fromMarker, toMarker);
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
  const settled = bestCost.get(entry.marker);
  return settled !== undefined && entry.cost > settled;
}

function relaxNeighbours(
  layout: LayoutState,
  current: FrontierEntry,
  bestCost: Map<string, number>,
  cameFrom: Map<string, { fromMarkerId: string; edge: EdgeRef }>,
  frontier: FrontierEntry[],
): void {
  for (const edge of layout.edgesFrom(current.marker)) {
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
