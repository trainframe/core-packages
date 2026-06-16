/**
 * Slot DISCOVERY for the railyard gantry (the toybox model). The gantry is a metal
 * construction dropped over a patch of real track — it owns NO track of its own. So
 * rather than being handed a slot list, it must IDENTIFY the slots in whatever it's
 * given: the stabling roads under its footprint.
 *
 * The heuristic is geometry-only (it works on any pieces, not a fixed layout): a yard's
 * stabling roads are the longest, MUTUALLY PARALLEL segments under the footprint — the
 * fan of sidings. The leads, throats, gaps and curves around them point every which way
 * and are shorter; the slots all run the same way. So: take the segments under the
 * footprint, keep the long ones, group by direction, and the biggest parallel group is
 * the slots. Finding fewer than two, the gantry has no yard to work and stalls.
 *
 * Pure: positions from the built network's endpoints. No DOM, no clock.
 */
import type { SegEndpoints } from './piece-network.js';

export interface Footprint {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Direction of a segment as an angle in [0,180) — undirected, so a road and its
 *  reverse compare equal. */
function angleOf(g: SegEndpoints): number {
  const a = (Math.atan2(g.end.y - g.start.y, g.end.x - g.start.x) * 180) / Math.PI;
  return ((a % 180) + 180) % 180;
}

/** Smallest gap between two undirected angles (≤ 90). */
function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

function lengthOf(g: SegEndpoints): number {
  return Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
}

function midIn(g: SegEndpoints, fp: Footprint): boolean {
  const mx = (g.start.x + g.end.x) / 2;
  const my = (g.start.y + g.end.y) / 2;
  return mx >= fp.minX && mx <= fp.maxX && my >= fp.minY && my <= fp.maxY;
}

/**
 * Discover the stabling-road (slot) segments under `footprint`. `minSlotLengthMm` filters
 * out the short connector/curve/gap pieces so only real roads remain; `angleToleranceDeg`
 * is how parallel two roads must be to count as the same fan. Returns the slot ids in the
 * network's segment order, or `[]` if no fan of ≥ 2 parallel roads is found.
 */
export function discoverYardSlots(
  segments: readonly string[],
  geom: ReadonlyMap<string, SegEndpoints>,
  footprint: Footprint,
  minSlotLengthMm = 300,
  angleToleranceDeg = 15,
): string[] {
  const roads = segments.filter((s) => {
    const g = geom.get(s);
    return g !== undefined && midIn(g, footprint) && lengthOf(g) >= minSlotLengthMm;
  });

  const groups: { angle: number; ids: string[] }[] = [];
  for (const s of roads) {
    const g = geom.get(s);
    if (g === undefined) continue;
    const a = angleOf(g);
    const grp = groups.find((x) => angleGap(x.angle, a) <= angleToleranceDeg);
    if (grp === undefined) groups.push({ angle: a, ids: [s] });
    else grp.ids.push(s);
  }

  groups.sort((x, y) => y.ids.length - x.ids.length);
  const best = groups[0];
  return best !== undefined && best.ids.length >= 2 ? best.ids : [];
}
