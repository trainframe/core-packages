/**
 * Adapts a PARALLELOGRAM yard (`parallelogram-yard.ts`) to the `YardLayout` seam the
 * reused `YardController` drives — so the proven on-rail carriage swap (route into a
 * slot, decouple the rear cut, pull clear, reverse onto the spares, exit the far lead)
 * runs UNCHANGED on this geometry. There is ONE swap mechanism; the parallelogram is
 * only its shape.
 *
 * The one true difference between the two yards is the SWITCH MODEL: the bezier yard
 * (`physics/yard.ts`) the controller was first built against diverges/converges through
 * a single multi-position switch (`Jw`/`Je`, positions `thru`/`slot0…`), whereas the
 * parallelogram is a LADDER of per-slot turnouts. `YardLayout.westSwitch`/`eastSwitch`
 * here are nominal labels: the composition binds the controller's two `SwitchActuator`s
 * to LADDER actuators (`sim/ladder-switch-actuator.ts`) that translate a `set('slotK')`
 * into the run of ladder throws that routes a lead to slot K. The controller is none
 * the wiser — it asks for a slot, the ladder obliges.
 *
 * Pure: geometry comes straight from the built network's endpoints. No DOM, no clock.
 */
import type { RailNetwork } from './network.js';
import type { ParallelogramYardSegments } from './parallelogram-yard.js';
import type { SegEndpoints } from './piece-network.js';
import type { YardLayout, YardSegGeom } from './yard.js';

/** Nominal switch labels (the actuators are ladder composites, not these ids). */
export const PARALLELOGRAM_WEST_SWITCH = 'top-ladder';
export const PARALLELOGRAM_EAST_SWITCH = 'bottom-ladder';

/** Project a built segment's endpoints to the controller's `{ax,ay,bx,by}` form. */
function toGeom(e: SegEndpoints): YardSegGeom {
  return { ax: e.start.x, ay: e.start.y, bx: e.end.x, by: e.end.y };
}

/**
 * Build the `YardLayout` view of a parallelogram yard. `leadWest` is the top lead's
 * entry stub (where a visitor arrives) and `leadEast` the bottom lead's exit (where it
 * departs) — a true drive-through, slots open both ends. `geom` carries every yard
 * segment's world endpoints (slots + both leads), which the controller reads to place
 * the crane camera and find each slot's far end.
 */
export function parallelogramYardLayout(
  net: RailNetwork,
  geom: ReadonlyMap<string, SegEndpoints>,
  seg: ParallelogramYardSegments,
): YardLayout {
  const g = new Map<string, YardSegGeom>();
  for (const id of [seg.topLeadIn, seg.bottomLeadOutSeg, ...seg.slots]) {
    const e = geom.get(id);
    if (e !== undefined) g.set(id, toGeom(e));
  }
  return {
    net,
    geom: g,
    leadWest: seg.topLeadIn,
    leadEast: seg.bottomLeadOutSeg,
    slots: seg.slots,
    westSwitch: PARALLELOGRAM_WEST_SWITCH,
    eastSwitch: PARALLELOGRAM_EAST_SWITCH,
  };
}
