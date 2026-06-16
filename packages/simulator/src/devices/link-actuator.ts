/**
 * A lift-bridge span as a physically-honest LINK actuator (ADR-031 §2,
 * experimental/005). It owns the PHYSICS of its own motion — the deck takes TIME
 * to raise and lower at a fixed rate — exactly as the `TurntableActuator` owns its
 * rotation. A controller commands INTENT (`setConnected(true/false)` → lower /
 * raise) and then AWAITS the physical result (`connected`, `raise`); it never
 * animates the span itself.
 *
 * The actuator owns one fact: whether its link is CONNECTED. The rail is connected
 * ONLY when the deck has fully SEATED (raise == 0). The instant a raise is
 * commanded the link drops to disconnected — the rail breaks at once, so a train
 * can never roll onto a deck that is on its way up (default-safe, the clearance
 * invariant). It re-connects only when the deck has mechanically come all the way
 * back down and seated.
 *
 * This is the device-side interface; the sim-backed implementation lives in `sim/`.
 * The controller reads `raise` (0 down … 1 fully up) to drive its clearance fact;
 * a view reads it to draw the real deck.
 */

/** A swappable lift-bridge span. The controller raises/lowers it ONLY through
 *  this. On real hardware the same interface drives a deck motor / hydraulic. */
export interface LinkActuator {
  /** Command the span DOWN (connected = true) or UP (connected = false). */
  setConnected(connected: boolean): void;
  /** Step the deck's motion by `dtS` seconds (the controller pumps this). */
  step(dtS: number): void;
  /** The deck's real raise fraction: 0 fully seated/down … 1 fully raised. */
  readonly raise: number;
  /** Whether the rail is physically connected RIGHT NOW (deck fully seated). */
  readonly connected: boolean;
  /** Whether the deck has reached its commanded extreme and stopped moving. */
  readonly settled: boolean;
}
