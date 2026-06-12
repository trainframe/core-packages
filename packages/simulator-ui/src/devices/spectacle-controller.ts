/**
 * The SPECTACLE orchestrator (ADR-030, ADR-026/027 handoff, ADR-031 §2). It runs
 * N trains around the spectacle loop and periodically peels ONE off into the
 * railyard for a full physics service, then rejoins it — all through HONEST
 * actuators (it emits motion/switch intent and observes occupancy + the yard's
 * own completion; it never animates a body or reads a position it could not
 * sense).
 *
 * COLLISION-FREE BY CONSTRUCTION. Every train circulates the SAME direction
 * (forward). The loop is cut into ordered blocks; the controller grants a train
 * clearance to drive only while the block immediately AHEAD of its leading body
 * is EMPTY of every other train. Same-direction running + one-train-per-block
 * separation means no two trains ever close on each other — there is nothing to
 * collide. (The physics' contact resolution is the backstop; in normal running
 * it never fires.)
 *
 * SERIALISED YARD. At most one train is ever in the yard. When a yard job is due
 * and its train has reached the diverge block AND the yard is idle, the
 * controller throws the loop points to the branch, hands the train to a real
 * `YardController` (the CORRECT physics yard service — camera scan, crane wedge,
 * proximity coupling on the real rails; ADR-027 handoff), and restores the points
 * so following trains keep circulating. When the yard service completes the train
 * is back on the loop (it left the yard heading the SAME way it entered — east —
 * so its facing never flipped) and rejoins ordinary block-clearance circulation.
 *
 * Tick-driven over a virtual clock; pure (no DOM, no Date.now, no Math.random).
 */
import type { SpectacleLayout } from '../physics/spectacle.js';
import type { BodyPose } from '../physics/world.js';
import type { SwitchActuator } from './switch-actuator.js';
import type { TrainDevice } from './train-device.js';
import { type Sighting, YardController } from './yard-controller.js';

/** A train under the controller's command: its lead loco device plus the ids of
 *  every body in its rake (loco + carriages), so the controller can find which
 *  block the whole train occupies. The rake membership is observed (couplings),
 *  passed in at registration. */
export interface SpectacleTrain {
  readonly train: TrainDevice;
  /** The lead loco's body id (the front of the train in travel order). */
  readonly locoId: string;
}

/** A queued yard service: which train to service, and which slots to use for the
 *  shed cut and the pick-up (swapping these between jobs makes a carriage migrate
 *  train→train — the shed cut of one visit becomes the spares of the next). */
export interface YardJob {
  readonly locoId: string;
  readonly entrySlot: string;
  readonly sparesSlot: string;
}

export interface SpectacleControllerDeps {
  readonly layout: SpectacleLayout;
  readonly trains: readonly SpectacleTrain[];
  /** The loop diverge points (Jloop) and the yard ladder points (Jw/Je). */
  readonly loopPoints: SwitchActuator;
  readonly westPoints: SwitchActuator;
  readonly eastPoints: SwitchActuator;
  /** Read the authoritative body poses (segment + position) — occupancy sensing. */
  readonly bodies: () => readonly BodyPose[];
  /** Position the yard camera and read what's beneath it. */
  readonly look: (x: number, y: number) => Sighting;
  readonly cameraRadius: number;
  /** Lower the yard crane wedge at world (x,y). */
  readonly wedgeAt: (x: number, y: number) => void;
  /** The per-loco motor actuator factory the yard service needs to drive a train
   *  (the controller hands the visiting train's device straight to the yard). */
  readonly yardJobs: readonly YardJob[];
}

type YardPhase = 'idle' | 'await-diverge' | 'in-yard' | 'rejoining';

export class SpectacleController {
  private readonly d: SpectacleControllerDeps;
  /** The loop block ids in travel order (a cycle). */
  private readonly order: readonly string[];
  /** Pending yard jobs, serviced one at a time in order. */
  private readonly jobs: YardJob[];
  /** The yard service in flight, or null when the yard is idle. */
  private yard: { ctrl: YardController; job: YardJob } | null = null;
  private yardPhase: YardPhase = 'idle';
  /** The loco currently routed to / in / leaving the yard (block logic skips it). */
  private serviced: string | null = null;
  /** Completed yard services (for the view / tests to read progress). */
  private completed = 0;

  constructor(deps: SpectacleControllerDeps) {
    this.d = deps;
    this.order = deps.layout.loop.map((b) => b.id);
    this.jobs = [...deps.yardJobs];
    /* Loop points default to through (loop) and yard ladder to through (dead-end
     *  the slots until a service routes them). */
    deps.loopPoints.set(deps.layout.loopThruPos);
  }

  /** How many yard services have completed (a swap each). */
  get servicesCompleted(): number {
    return this.completed;
  }

  /** The current yard phase (for the view / tests). */
  get phase(): YardPhase {
    return this.yardPhase;
  }

  tick(dtS: number): void {
    this.driveLoopTrains();
    this.driveYard(dtS);
  }

  /** Grant each free-running train block clearance: drive it forward only while
   *  the block AHEAD of its leading body is empty of other trains. The serviced
   *  train is skipped (the yard / rejoin logic owns it). */
  private driveLoopTrains(): void {
    const poses = this.d.bodies();
    for (const t of this.d.trains) {
      if (t.locoId === this.serviced) continue;
      const locoSeg = poses.find((b) => b.id === t.locoId)?.segment;
      if (locoSeg === undefined) continue;
      if (this.nextBlockClear(t, locoSeg, poses)) t.train.forward();
      else t.train.stop();
    }
  }

  /** Whether the block immediately ahead of this train's loco is clear of every
   *  OTHER train's bodies. A loco off the loop blocks (on a connector / in the
   *  yard) is always cleared to keep moving — only loop blocks are rationed. */
  private nextBlockClear(
    self: SpectacleTrain,
    locoSeg: string,
    poses: readonly BodyPose[],
  ): boolean {
    const idx = this.order.indexOf(locoSeg);
    if (idx === -1) return true; // not on a loop block (connector / yard)
    const nextBlock = this.order[(idx + 1) % this.order.length];
    if (nextBlock === undefined) return true;
    const ownRake = this.rakeIds(self.locoId, poses);
    return !poses.some((b) => b.segment === nextBlock && !ownRake.has(b.id));
  }

  /** The set of body ids coupled into the loco's rake (flood-fill over couplings),
   *  so a train never treats its own trailing cars as a blocker. */
  private rakeIds(locoId: string, poses: readonly BodyPose[]): Set<string> {
    const byId = new Map(poses.map((b) => [b.id, b] as const));
    const seen = new Set<string>([locoId]);
    const stack = [locoId];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) continue;
      for (const n of byId.get(cur)?.coupledTo ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return seen;
  }

  /** Drive the yard side: pick up the next job, wait for its train to reach the
   *  diverge block, route it into the yard via a real `YardController`, then
   *  restore the loop and rejoin the train. */
  private driveYard(dtS: number): void {
    switch (this.yardPhase) {
      case 'idle':
        this.maybeStartJob();
        break;
      case 'await-diverge':
        this.awaitDiverge();
        break;
      case 'in-yard':
        this.runYard(dtS);
        break;
      case 'rejoining':
        this.rejoin();
        break;
    }
  }

  /** Begin the next queued job once the yard is idle: mark its train and wait for
   *  it to roll up to the diverge block. */
  private maybeStartJob(): void {
    if (this.jobs.length === 0 || this.yard !== null) return;
    const job = this.jobs[0];
    if (job === undefined) return;
    this.serviced = null; // not yet — only once it's at the diverge
    this.yardPhase = 'await-diverge';
  }

  /** Hold for the job train to reach the diverge block, bring it to REST there
   *  (so it enters the yard from a standstill — the exact regime the yard service
   *  is calibrated for, rather than carrying loop momentum), then throw the loop
   *  points to the branch and hand the train to a fresh `YardController`. */
  private awaitDiverge(): void {
    const job = this.jobs[0];
    if (job === undefined) {
      this.yardPhase = 'idle';
      return;
    }
    const poses = this.d.bodies();
    const loco = poses.find((b) => b.id === job.locoId);
    if (loco?.segment !== this.d.layout.divergeBlock) return; // not at the diverge yet
    const train = this.d.trains.find((t) => t.locoId === job.locoId)?.train;
    if (train === undefined) {
      this.finishJob();
      return;
    }
    /* Take ownership and brake to a stand before routing into the yard. */
    this.serviced = job.locoId;
    if (loco.speed > 6) {
      train.stop();
      return;
    }
    /* At rest at the diverge: throw the loop points to the branch and hand off. */
    this.d.loopPoints.set(this.d.layout.loopYardPos);
    this.yard = {
      job,
      ctrl: new YardController({
        layout: this.d.layout.yard,
        train,
        westPoints: this.d.westPoints,
        eastPoints: this.d.eastPoints,
        look: this.d.look,
        cameraRadius: this.d.cameraRadius,
        wedgeAt: this.d.wedgeAt,
        entrySlot: job.entrySlot,
        sparesSlot: job.sparesSlot,
      }),
    };
    this.yardPhase = 'in-yard';
  }

  /** Step the in-flight yard service. Once the train has crossed onto the diverge
   *  connector / yard, restore the loop points so following trains keep
   *  circulating. When the yard reports done, move to rejoin. */
  private runYard(dtS: number): void {
    const cur = this.yard;
    if (cur === null) {
      this.yardPhase = 'idle';
      return;
    }
    cur.ctrl.tick(dtS);
    /* Hold the loop points at the branch until the ENTIRE rake (loco + every
     *  trailing car) has left the diverge block onto the yard connector — else a
     *  trailing car would take the through route while the loco took the branch,
     *  tearing the rake across the junction. Only once the last car is clear do we
     *  restore the through route for the rest of the fleet. */
    const poses = this.d.bodies();
    const rake = this.rakeIds(cur.job.locoId, poses);
    const rakeStillOnLoop = poses.some((b) => rake.has(b.id) && this.order.includes(b.segment));
    if (!rakeStillOnLoop) {
      this.d.loopPoints.set(this.d.layout.loopThruPos);
    }
    if (cur.ctrl.currentPhase === 'done') {
      this.yardPhase = 'rejoining';
    }
  }

  /** The yard handed the train back on the east lead. Drive it forward to climb
   *  the return connector onto the loop, then release it to ordinary circulation. */
  private rejoin(): void {
    const job = this.jobs[0];
    const train = job ? this.d.trains.find((t) => t.locoId === job.locoId)?.train : undefined;
    train?.forward();
    const poses = this.d.bodies();
    const locoSeg = job ? poses.find((b) => b.id === job.locoId)?.segment : undefined;
    /* Once the loco is back on a loop block, the rejoin is complete. */
    if (locoSeg !== undefined && this.order.includes(locoSeg)) this.finishJob();
  }

  /** Retire the current job: free the yard, un-mark the serviced train, and tally. */
  private finishJob(): void {
    this.jobs.shift();
    this.yard = null;
    this.serviced = null;
    this.completed += 1;
    this.yardPhase = 'idle';
  }
}
