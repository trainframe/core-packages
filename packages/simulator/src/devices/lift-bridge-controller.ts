/**
 * The lift bridge as a portable controller (ADR-030 §1, ADR-031, experimental/005).
 * It carries `core.gates_clearance` over a PHYSICAL fact — whether the track span
 * is there — and holds a train OUT while the span is raised, exactly as a
 * level-crossing gate withholds for road traffic. It is the INVERSE of the crane:
 * the crane pins a train in place to work ON it; the bridge holds trains OUT of a
 * region while the span is up.
 *
 * It perceives ONLY through a camera-look (and its own commanded span state) and
 * acts ONLY through actuators: the train's motor and the `LinkActuator` (the span).
 * Nothing is keyframed; the span owns its raise physics and the controller only
 * COMMANDS intent and AWAITS the physical result (`connected`/`settled`).
 *
 *   raised   the span starts UP (the rail is broken). The train is approaching but
 *            its motion is WITHHELD — clearance across the gap is denied while the
 *            span is up, so it holds short of the gap and does NOT run off
 *   lower    command the span DOWN and await it physically SEATING (`connected`).
 *            The train stays withheld throughout — default-safe: clearance is
 *            granted only once the rail is actually back
 *   cross    the span is seated → release: drive the train forward across the now-
 *            continuous span onto the far approach
 *   done     the train is sensed on the far side — it has crossed the span
 *
 * Tick-driven over a virtual clock; pure (no DOM, no Date.now). It never reads
 * simulator ground truth — only what the camera sees and what it itself commanded.
 */
import type { LinkActuator } from './link-actuator.js';
import type { TrainDevice } from './train-device.js';

/** What the camera reports beneath its footprint (same shape the yard/turntable use). */
export interface Sighting {
  readonly occupied: boolean;
  readonly colour?: string | undefined;
}

export interface LiftBridgeControllerDeps {
  readonly train: TrainDevice;
  readonly span: LinkActuator;
  /** Look at world (x,y) and report what's beneath the footprint there. */
  readonly look: (x: number, y: number) => Sighting;
  /** A world point on the FAR approach, past the span — the train is sensed here
   *  once it has crossed. */
  readonly farSensePoint: { readonly x: number; readonly y: number };
  /** How long (s) to hold the span raised after the train arrives before lowering
   *  it — the out-of-scope entity (boat/road) passing under. Default 0. */
  readonly holdRaisedS?: number;
}

type Phase = 'raised' | 'lower' | 'cross' | 'done';

export class LiftBridgeController {
  private readonly d: LiftBridgeControllerDeps;
  private phase: Phase = 'raised';
  private timer = 0;
  /** Whether the single "go" for the cross phase has been issued. */
  private crossCommanded = false;

  constructor(deps: LiftBridgeControllerDeps) {
    this.d = deps;
    /* Start with the span up and the train held — the rail is broken. */
    this.d.span.setConnected(false);
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  /** Whether the bridge is currently WITHHOLDING clearance across the span (its
   *  `core.gates_clearance` state). It withholds while the span is not seated —
   *  the train is held out — and grants only once the rail is physically back. */
  get withholding(): boolean {
    return !this.d.span.connected;
  }

  tick(dtS: number): void {
    this.timer += dtS;
    /* The span owns its own raise physics; we only step it. */
    this.d.span.step(dtS);
    switch (this.phase) {
      case 'raised':
        this.raised();
        break;
      case 'lower':
        this.lower();
        break;
      case 'cross':
        this.cross();
        break;
      case 'done':
        break;
    }
  }

  private to(phase: Phase): void {
    this.phase = phase;
    this.timer = 0;
  }

  /** The span is up and the rail is broken: WITHHOLD the train (it holds short of
   *  the gap) for the configured dwell, then begin lowering. */
  private raised(): void {
    this.d.train.stop();
    if (this.timer >= (this.d.holdRaisedS ?? 0)) {
      this.d.span.setConnected(true);
      this.to('lower');
    }
  }

  /** Await the span physically seating. The train stays WITHHELD until the rail is
   *  actually back (default-safe — clearance is granted only on a seated span). */
  private lower(): void {
    this.d.train.stop();
    if (this.d.span.connected && this.d.span.settled) this.to('cross');
  }

  /** The span is seated: GRANT — give ONE "go" and watch the train cross. */
  private cross(): void {
    if (!this.crossCommanded) {
      this.d.train.forward();
      this.crossCommanded = true;
    }
    if (this.d.look(this.d.farSensePoint.x, this.d.farSensePoint.y).occupied) {
      this.d.train.stop();
      this.to('done');
    }
  }
}
