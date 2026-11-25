import { type SchedulerEffect, clearanceStateEffect, effects } from './effects.js';
import type { LayoutState } from './layout-state.js';
import type { ClearanceRetry, TransitPlanning } from './seams.js';
import type { TrainRoster } from './train-roster.js';
import type { TrainState } from './train-state.js';
import { type EdgeRef, edgesEqual } from './types.js';

/**
 * Topology violations (ADR-019): a train on a bounded route reporting a marker
 * its last certain position has no edge to is held, its uncertain region kept
 * occupied, until an operator re-anchors it or confirms the adjacency as new
 * track.
 */
export class TopologyGuard {
  constructor(
    private readonly layout: Pick<
      LayoutState,
      'name' | 'findEdge' | 'hasMarker' | 'hasIncidentEdges' | 'addInferredEdge' | 'toLayout'
    >,
    private readonly trains: Pick<TrainRoster, 'get'>,
    private readonly now: () => number,
    private readonly clearance: ClearanceRetry,
    private readonly schedules: TransitPlanning,
  ) {}

  /**
   * Is this train running a bounded route the scheduler issued (ADR-019
   * "expecting" mode)? True iff it has a planned transit — the discriminator
   * is per-train state the scheduler already holds, not a new flag. A train
   * exploring (ADR-015) or under track-learn (ADR-014) is driven by an
   * open-ended `begin_exploration` grant issued straight to the device and
   * never has a `transit`, so it is in OPEN mode (`false`) and an unexplained
   * adjacency is the discovery signal, not a violation. The coarse global
   * `--discovery` layout is the degenerate case: no routes assigned ⇒ every
   * train open.
   */
  private isExpecting(train: TrainState): boolean {
    return train.transit !== undefined;
  }

  /**
   * ADR-019 step 5 detector. Returns the last certain marker (P) when the
   * report is a topology violation, else `null`. A violation is: P is anchored,
   * M is not a re-read of P, the graph has no edge P→M (confirmed or inferred),
   * and the train is in EXPECTING mode (a bounded route it could contradict).
   * The other four §5 cases (P undefined, M==P, edge exists, OPEN mode) all
   * return `null` and fall through to normal handling. Pure graph lookups, so
   * the determinism contract holds.
   */
  detectViolation(
    train: TrainState,
    previousMarker: string | undefined,
    markerId: string,
  ): { lastKnownMarkerId: string } | null {
    if (previousMarker === undefined) return null;
    if (previousMarker === markerId) return null;
    if (this.layout.findEdge(previousMarker, markerId) !== undefined) return null;
    if (!this.isExpecting(train)) return null;
    return { lastKnownMarkerId: previousMarker };
  }

  /**
   * ADR-019 topology violation: the train reported a marker unreachable from
   * its last certain position while running a bounded route. The three causes
   * (sensor fault / genuine new edge / lifted-and-replaced train) cannot be
   * told apart from the event, so the AUTOMATIC action is uniform and
   * default-safe — declare the position uncertain, hold, and flag — never an
   * auto-classifier that keeps the train rolling on a guess.
   *
   *  - Do NOT learn the phantom edge (no `recordTraversal`): a misread must not
   *    become a permanent fact the planner later routes a real train across.
   *  - Mark the uncertain region (P→M) as occupied by retaining it in
   *    `cleared_edges`. Block exclusivity (ADR-002) then denies markers P and M
   *    to every peer for free — no new neighbour-holding mechanism. This works
   *    even when M is wholly unknown to the graph: `cleared_edges` is a list of
   *    EdgeRefs, not graph edges, so nothing requires P→M to exist.
   *  - Pin the clearance limit to P (the last certain boundary) and STOP the
   *    train. Clearance is push, not poll: pinning the scheduler's internal
   *    limit does not retract a grant the train already holds, so we must send
   *    an explicit `revoke_clearance` — otherwise a train that had onward
   *    clearance keeps rolling into uncertain territory (the "keep rolling on a
   *    guess" hazard §2 rejects). We do NOT call `revokeClearance()`: that wipes
   *    `cleared_edges`, and we need the uncertain region retained as occupancy.
   *  - Surface the hold on the retained clearance state via `block_reason`
   *    (scheduler-owned) and emit the one-shot `topology_violation` event.
   *
   * `last_marker_id` is intentionally NOT advanced by the caller — it stays at
   * P. Pure graph lookups + injected clock only; determinism preserved.
   */
  hold(
    train: TrainState,
    lastKnownMarkerId: string,
    reportedMarkerId: string,
  ): ReadonlyArray<SchedulerEffect> {
    const uncertainEdge: EdgeRef = {
      from_marker_id: lastKnownMarkerId,
      to_marker_id: reportedMarkerId,
    };
    if (!train.cleared_edges.some((e) => edgesEqual(e, uncertainEdge))) {
      train.cleared_edges = [...train.cleared_edges, uncertainEdge];
    }
    train.clearance_limit_marker_id = lastKnownMarkerId;
    train.block_reason = 'unknown_topology';

    return [
      /* Halt the train on the wire — default-safe. `cleared_edges` is left
       * intact so block exclusivity keeps denying the uncertain region to peers. */
      effects.sendCommand(train.train_id, 'revoke_clearance', {
        reason: 'unknown_topology',
        immediate: true,
      }),
      effects.publishEvent('topology_violation', {
        train_id: train.train_id,
        last_known_marker_id: lastKnownMarkerId,
        reported_marker_id: reportedMarkerId,
        suspected_cause: this.suspectedCause(lastKnownMarkerId, reportedMarkerId),
        detected_at_ms: this.now(),
      }),
      clearanceStateEffect(train),
    ];
  }

  /**
   * Coarse hint for the operator UI (ADR-019 §4). Never an input to the
   * automatic action. The scheduler defaults to `'unknown'`; the one sanctioned
   * refinement is that a marker the graph already knows (just not adjacent to P)
   * is more likely a missed/misread sensor than brand-new track. Richer
   * inference is explicitly deferred.
   */
  private suspectedCause(
    _lastKnownMarkerId: string,
    reportedMarkerId: string,
  ): 'sensor_fault' | 'unknown_edge' | 'lifted_train' | 'unknown' {
    /* The one sanctioned refinement: a marker the graph already knows AND that
     * is wired into the topology (has incident edges) is more likely a
     * missed/misread sensor than brand-new track. A marker unknown to the
     * graph, or known but with no incident edges (an orphan), leaves the
     * position genuinely undetermined → keep the default `'unknown'` (maximal
     * hold). Never an input to the automatic action. */
    return this.layout.hasIncidentEdges(reportedMarkerId) ? 'sensor_fault' : 'unknown';
  }

  /**
   * ADR-019 recovery — RE-ANCHOR. An operator re-establishes the train's
   * certain position (re-scans it at a known marker, or confirms where it is).
   * This is the sensor-fault and lifted-train recovery: the phantom report is
   * discarded, the uncertain region is released, the hold lifts, and scheduled
   * operation resumes by replanning from the confirmed marker. The phantom edge
   * is never learned. No-op if the train isn't held for `unknown_topology`, or
   * if the confirmed marker is unknown to the layout.
   */
  reanchor(trainId: string, confirmedMarkerId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train || train.block_reason !== 'unknown_topology') return [];
    if (!this.layout.hasMarker(confirmedMarkerId)) return [];

    /* Release everything the held train was occupying (including the uncertain
     * P→M span) and re-anchor at the operator-confirmed marker. */
    train.cleared_edges = [];
    train.block_reason = undefined;
    train.last_marker_id = confirmedMarkerId;
    train.clearance_limit_marker_id = confirmedMarkerId;
    train.transit = undefined;

    return [clearanceStateEffect(train), ...this.resumeAfterRecovery(train)];
  }

  /**
   * ADR-019 recovery — CONFIRM NEW TRACK. An operator confirms the unreachable
   * adjacency P→M is real, undiscovered track. This is precisely the track-learn
   * gesture (ADR-014): the edge IS learned (as inferred, like any discovery),
   * the train re-anchors at M, the hold lifts, and scheduled operation resumes.
   * A topology violation under a route is therefore a clean entry point into
   * learn mode, not a dead end. No-op if the train isn't held for
   * `unknown_topology` or no uncertain edge can be located.
   */
  confirmNewTrack(trainId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train || train.block_reason !== 'unknown_topology') return [];

    /* The uncertain edge is the one held edge the graph does not contain — the
     * P→M adjacency we declined to learn at violation time. */
    const uncertainEdge = train.cleared_edges.find(
      (e) => this.layout.findEdge(e.from_marker_id, e.to_marker_id) === undefined,
    );
    if (!uncertainEdge) return [];

    this.layout.addInferredEdge(uncertainEdge.from_marker_id, uncertainEdge.to_marker_id);

    train.cleared_edges = [];
    train.block_reason = undefined;
    train.last_marker_id = uncertainEdge.to_marker_id;
    train.clearance_limit_marker_id = uncertainEdge.to_marker_id;
    train.transit = undefined;

    return [
      effects.updateState('layout', this.layout.name, this.layout.toLayout()),
      clearanceStateEffect(train),
      ...this.resumeAfterRecovery(train),
    ];
  }

  /**
   * Resume scheduled operation after a recovery gesture. If the train still has
   * a schedule, replan a fresh transit from its (now certain) marker toward the
   * current target stop; otherwise it simply sits cleared at its anchor. Shared
   * by both recovery paths.
   */
  private resumeAfterRecovery(train: TrainState): ReadonlyArray<SchedulerEffect> {
    if (!train.schedule) return this.clearance.retryBlockedClearances();
    return [
      ...this.schedules.planAndExecuteCurrentTransit(train),
      ...this.clearance.retryBlockedClearances(),
    ];
  }
}
