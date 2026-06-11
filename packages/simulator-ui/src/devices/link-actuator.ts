/**
 * A lift-bridge span as a physically-honest LINK actuator (ADR-031 §2,
 * experimental/005). It owns the PHYSICS of its own motion — the deck takes TIME
 * to raise and lower at a fixed rate — exactly as the `TurntableActuator` owns its
 * rotation. A device commands INTENT (`setConnected(true/false)` → lower / raise)
 * and then AWAITS the physical result (`connected`, `raise`); it never animates
 * the span itself and never reads simulator ground truth.
 *
 * The actuator owns one fact the network reads through the world: whether its
 * link is CONNECTED. The rail is connected ONLY when the deck has fully SEATED
 * (raise == 0). The instant a raise is commanded the link drops to disconnected
 * — the rail breaks at once, so a train can never roll onto a deck that is on its
 * way up (default-safe, exactly the clearance invariant). It only re-connects
 * when the deck has mechanically come all the way back down and seated.
 *
 * Pure kinematics over a virtual clock (no DOM, no Date.now) — `step(dt)`
 * integrates the raise fraction, `setConnected` retargets, `raise`/`connected`
 * report. The view reads `raise` (0 down … 1 fully up) to draw the real deck.
 */
import type { PhysicsWorld } from '../physics/world.js';

/** A swappable lift-bridge span. The controller raises/lowers it ONLY through
 *  this. On real hardware the same interface drives a deck motor / hydraulic. */
export interface LinkActuator {
  /** Command the span DOWN (connected = true) or UP (connected = false). */
  setConnected(connected: boolean): void;
  /** Step the deck's motion by `dtS` seconds (the controller pumps this). */
  step(dtS: number): void;
  /** The deck's real raise fraction: 0 fully seated/down … 1 fully raised. The
   *  view reads THIS; it never animates its own. */
  readonly raise: number;
  /** Whether the rail is physically connected RIGHT NOW (deck fully seated). */
  readonly connected: boolean;
  /** Whether the deck has reached its commanded extreme and stopped moving. */
  readonly settled: boolean;
}

/** Span raise/lower rate (fraction per second). Deliberately leisurely so the
 *  lift reads as a deliberate mechanical motion over a couple of seconds. */
const RATE = 0.5;

/** A sim-backed lift-bridge actuator. Owns the raise fraction; when it seats fully
 *  down it CONNECTS its link on the world, and the instant it leaves the seated
 *  state it DISCONNECTS it — so the rail is present only when the span is down. */
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
        /* leaving the seated state — drop the link now even before motion. */
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
