/**
 * Sim-backed `LinkActuator` (ADR-030/031): binds the lift-bridge span interface to
 * the simulator's link table. This is sim-wiring, NOT device logic — the only
 * layer permitted to touch the world. Owns the raise fraction; when the deck seats
 * fully down it CONNECTS its link, and the instant it leaves the seated state it
 * DISCONNECTS it — so the rail is present only when the span is down.
 */
import type { LinkActuator } from '../devices/link-actuator.js';
import type { PhysicsWorld } from '../physics/world.js';

/** Span raise/lower rate (fraction per second). Deliberately leisurely so the lift
 *  reads as a deliberate mechanical motion over a couple of seconds. */
const RATE = 0.5;

/** A sim-backed lift-bridge actuator. */
export function physicsLinkActuator(
  world: PhysicsWorld,
  linkId: string,
  opts: { readonly startRaised?: boolean } = {},
): LinkActuator {
  /* target: 0 = commanded down (connect), 1 = commanded up (disconnect). */
  let raise = opts.startRaised ? 1 : 0;
  let target = raise;
  /* The link is connected only while the deck is fully seated down. */
  const sync = (): void => world.setLinkActive(linkId, raise <= 0);
  sync();
  return {
    setConnected(connected: boolean): void {
      target = connected ? 0 : 1;
      /* Breaking the rail is INSTANT-safe: the moment we are no longer fully
       *  seated down, the link is absent. Re-connecting waits for full seating. */
      if (!connected && raise <= 0) {
        raise = Math.min(1, raise + 1e-6);
        sync();
      }
    },
    step(dtS: number): void {
      if (raise === target) return;
      const d = target - raise;
      const move = Math.sign(d) * Math.min(Math.abs(d), RATE * dtS);
      raise = Math.max(0, Math.min(1, raise + move));
      sync();
    },
    get raise(): number {
      return raise;
    },
    get connected(): boolean {
      return raise <= 0;
    },
    get settled(): boolean {
      return Math.abs(raise - target) < 1e-6;
    },
  };
}
