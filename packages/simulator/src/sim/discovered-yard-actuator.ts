/**
 * Sim-backed LADDER `SwitchActuator` for a DISCOVERED yard — the bridge that lets the
 * reused `YardController` (which thinks in a single multi-position diverge/converge
 * switch) drive the operator's REAL junctions in the one `compileNetwork` net. The
 * controller calls `set(slotId)` to route a lead into one slot, or `set('thru')` to keep
 * every slot a dead-end; this translates that into the underlying junction throws the
 * `discoveredYardLayout` adapter inferred (`SlotLadder[]`).
 *
 * The crux (and what `sim/ladder-switch-actuator.ts` gets right and a naive per-slot loop
 * gets wrong): several slots may share ONE junction — a passing-loop's facing turnout
 * routes the LOOP on `divert` and the MAIN on `main`. So we set the TARGET slot's switch
 * to its throw and EVERY OTHER ladder switch to `main`; we never let a later slot's `main`
 * clobber the target's `divert` on the SAME junction. Sim-wiring only (touches the world);
 * the device sees a plain `SwitchActuator` and never knows a ladder exists.
 */
import type { SwitchActuator } from '../devices/switch-actuator.js';
import type { SlotLadder } from '../physics/discovered-yard-layout.js';
import type { PhysicsWorld } from '../physics/world.js';

/** Build a ladder actuator over one side's discovered junctions. `set(slotId)` routes
 *  that side's lead into the slot; any non-slot position (`thru`) sends every junction
 *  to its `main` (through) leg. */
export function discoveredYardActuator(
  world: PhysicsWorld,
  ladder: readonly SlotLadder[],
  side: 'west' | 'east',
): SwitchActuator {
  const throwFor = (l: SlotLadder): { switchId: string; position: string } | null =>
    side === 'west' ? l.west : l.east;
  const allSwitches = new Set<string>();
  for (const l of ladder) {
    const t = throwFor(l);
    if (t !== null) allSwitches.add(t.switchId);
  }
  return {
    set(position: string): void {
      const target = ladder.find((l) => l.slot === position);
      const targetThrow = target === undefined ? null : throwFor(target);
      for (const switchId of allSwitches) {
        const pos =
          targetThrow !== null && targetThrow.switchId === switchId ? targetThrow.position : 'main';
        world.setSwitch(switchId, pos);
      }
    },
  };
}
