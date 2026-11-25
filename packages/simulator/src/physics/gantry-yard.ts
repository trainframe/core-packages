/**
 * Discovers a drivable yard from the track under a gantry. The gantry owns no track:
 * its footprint is the box over the stabling roads, the slots are whatever
 * `discoverYardSlots` finds beneath it, and the layout is inferred from the net's own
 * adjacency (`discoveredYardLayout`).
 */
import { discoverYardSlots } from './discover-yard.js';
import type { Footprint } from './discover-yard.js';
import { type DiscoveredYard, discoveredYardLayout } from './discovered-yard-layout.js';
import type { RailNetwork } from './network.js';
import type { LegGate, SegEndpoints } from './piece-network.js';

/** A built piece network the gantry is dropped over. */
export interface GantryTrack {
  readonly net: RailNetwork;
  readonly geom: ReadonlyMap<string, SegEndpoints>;
  readonly legGates: ReadonlyMap<string, LegGate>;
}

/** The footprint a gantry dropped over `roads` covers: the box bounding their endpoints. */
export function footprintOver(
  geom: ReadonlyMap<string, SegEndpoints>,
  roads: readonly string[],
): Footprint {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const id of roads) {
    const g = geom.get(id);
    if (g === undefined) continue;
    xs.push(g.start.x, g.end.x);
    ys.push(g.start.y, g.end.y);
  }
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/**
 * Drop a gantry over the stabling `roads` of `track` and discover the yard beneath it.
 * `entryPoint` is where a visitor arrives, which decides each road's entry side. Throws
 * when the footprint covers no fan of at least two roads fronting two leads.
 */
export function discoverGantryYard(
  track: GantryTrack,
  roads: readonly string[],
  entryPoint: { x: number; y: number },
): DiscoveredYard {
  const slots = discoverYardSlots(
    track.net.segments(),
    track.geom,
    footprintOver(track.geom, roads),
  );
  const yard = discoveredYardLayout(track.net, track.geom, slots, {
    junctionSwitchIds: [],
    legGates: track.legGates,
    entryPoint,
  });
  if (yard === null) throw new Error('gantry-yard: no yard discovered under the footprint');
  return yard;
}
