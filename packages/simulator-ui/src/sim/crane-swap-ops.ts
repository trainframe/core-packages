/**
 * Sim-backing for the railyard CRANE-SWAP (ADR-030/031): the world operations a
 * gantry crane's lift + set-down actually perform. This is sim-wiring, NOT device
 * logic — the only layer permitted to touch the world. The `CraneSwapController`
 * receives `liftCut`/`placeCut` and never knows a world exists; on hardware the
 * same two callbacks are the electromagnet energising/de-energising plus a vision
 * fix re-registering the wagons.
 *
 *   - liftCut(x,y): take the `count` rolling-stock bodies nearest (x,y) OFF the
 *     rails (a hook can only lift what is under it), remembering each one's
 *     identity so it can be set down faithfully later. Returns the lifted ids,
 *     ordered along the rail so the rake keeps its makeup.
 *   - placeCut(ids,x,y): set a held cut DOWN as a contiguous rake at the rail
 *     nearest (x,y), couple its wagons together, and — if a body is already parked
 *     at the drop (a loco waiting to be re-rake) — couple the cut onto it.
 *
 * Pure given the world; no DOM, no clock, no randomness.
 */
import type { BodyKind } from '../physics/observation.js';
import type { PhysicsWorld } from '../physics/world.js';

/** Wagon spacing (mm) when a lifted cut is set back down as a rake — matches the
 *  seeding spacing so a dropped rake sits at coupler contact, not overlapping. */
const WAGON_SPACING = 68;
/** How near (mm) a parked body must be to the drop point for the set-down cut to
 *  couple onto it (the loco waiting to be re-raked). */
const ATTACH_RANGE = 90;

export interface CraneSwapOps {
  readonly liftCut: (x: number, y: number) => readonly string[];
  readonly placeCut: (ids: readonly string[], x: number, y: number) => void;
}

interface Lifted {
  readonly kind: BodyKind;
  readonly color: string | undefined;
}

/** Build the lift/place callbacks for `world`, lifting `count` bodies per grab
 *  (the crane's two-wagon cradle). The returned ops remember the identity of
 *  whatever they lift so a later `placeCut` re-seats the same wagons. */
export function craneSwapOps(world: PhysicsWorld, count = 2): CraneSwapOps {
  const lifted = new Map<string, Lifted>();

  const liftCut = (x: number, y: number): readonly string[] => {
    /* The `count` railed wagons whose centres are nearest the hook, ordered along
     *  the rail (descending railPos) so the rake keeps its front-to-back makeup. */
    const near = world
      .bodies()
      .filter((b) => b.mode === 'railed' && b.kind === 'carriage')
      .map((b) => ({ b, d2: (b.x - x) ** 2 + (b.y - y) ** 2 }))
      .sort((p, q) => p.d2 - q.d2)
      .slice(0, count)
      .map((p) => p.b);

    const ids: string[] = [];
    for (const b of near) {
      lifted.set(b.id, { kind: b.kind, color: b.color });
      world.removeBody(b.id);
      ids.push(b.id);
    }
    return ids;
  };

  const placeCut = (ids: readonly string[], x: number, y: number): void => {
    if (ids.length === 0) return;
    const at = world.nearestRail(x, y);
    /* Seat the cut as a contiguous rake trailing back from the drop point. */
    ids.forEach((id, i) => {
      const meta = lifted.get(id) ?? { kind: 'carriage' as BodyKind, color: undefined };
      lifted.delete(id);
      world.addBody({
        id,
        kind: meta.kind,
        facing: 1,
        segment: at.segment,
        railPos: at.railPos - i * WAGON_SPACING,
        ...(meta.color !== undefined ? { color: meta.color } : {}),
      });
    });
    /* Couple the wagons into one rake. */
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1];
      const cur = ids[i];
      if (prev !== undefined && cur !== undefined) world.couple(prev, cur);
    }
    /* If a body is already parked at the drop (a loco awaiting its new rake),
     *  couple the lead wagon onto it — this is what re-rakes the train. */
    const lead = ids[0];
    if (lead === undefined) return;
    const placed = new Set(ids);
    const host = world
      .bodies()
      .filter((b) => b.mode === 'railed' && !placed.has(b.id))
      .map((b) => ({ b, d: Math.hypot(b.x - x, b.y - y) }))
      .filter((p) => p.d <= ATTACH_RANGE)
      .sort((p, q) => p.d - q.d)[0];
    if (host !== undefined) world.couple(host.b.id, lead);
  };

  return { liftCut, placeCut };
}
