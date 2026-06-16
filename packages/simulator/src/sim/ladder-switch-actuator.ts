/**
 * Sim-backed LADDER `SwitchActuator` — the bridge that lets the reused `YardController`
 * (which thinks in a single multi-position diverge/converge switch) drive a parallelogram
 * yard's LADDER of per-slot turnouts. The controller calls `set(slotId)` to route a lead
 * to one slot, or `set('thru')` to keep every slot a dead-end; this actuator translates
 * that into the run of underlying turnout throws.
 *
 * The mapping is symmetric for both leads: to select slot K, throw turnout K to its
 * branch (`slot`) and every other turnout to `thru`; for `thru` (or any non-slot
 * position) throw them all to `thru`. Outer-corner slots carry no turnout (a plain
 * curve, `undefined` in the array) — selecting one just means all turnouts `thru` and
 * the lead curves into it. Sim-wiring only (touches the world); the device sees a plain
 * `SwitchActuator` and never knows a ladder exists.
 */
import type { SwitchActuator } from '../devices/switch-actuator.js';
import type { ParallelogramYardSegments } from '../physics/parallelogram-yard.js';
import type { PhysicsWorld } from '../physics/world.js';

/** Build a ladder actuator over one lead's turnouts (`top` → the entry lead, `bottom`
 *  → the exit lead). `set(slotId)` routes that lead to the slot; `set('thru')` makes
 *  every slot a dead-end. */
export function ladderSwitchActuator(
  world: PhysicsWorld,
  seg: ParallelogramYardSegments,
  lead: 'top' | 'bottom',
): SwitchActuator {
  const switches = lead === 'top' ? seg.topSwitches : seg.bottomSwitches;
  return {
    set(position: string): void {
      const target = seg.slots.indexOf(position); // -1 → not a slot → all thru
      switches.forEach((sw, i) => {
        if (sw === undefined) return;
        world.setSwitch(sw, target >= 0 && i === target ? seg.slotPos : seg.thruPos);
      });
    },
  };
}
