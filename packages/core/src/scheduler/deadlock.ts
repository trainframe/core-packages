import { type SchedulerEffect, clearanceStateEffect, effects } from './effects.js';
import type { LayoutState } from './layout-state.js';
import type { ClearanceRetry } from './seams.js';
import { type TrainRoster, compareTrains } from './train-roster.js';
import type { TrainState } from './train-state.js';
import { type EdgeRef, anyEdgeSharesMarker, edgeSharesMarker, edgesEqual } from './types.js';

/**
 * Waits-for deadlock detection over the trains' held clearance, and the two
 * cures for a cycle: the lowest-ranked train yields claims it has not entered
 * (ADR-017), or, in a closed nose-to-nose standoff, is granted a reverse out of
 * the block a peer needs (ADR-022). Runs at the end of every clearance retry
 * pass and publishes the retained deadlock state when the set changes.
 */
export class DeadlockResolver {
  /**
   * The set of trains currently part of a detected waits-for cycle (sorted,
   * for stable equality checks). Kept so we only publish a
   * `railway/state/deadlock/active` retained snapshot when the deadlock set
   * actually changes — not on every event.
   */
  private currentDeadlock: ReadonlyArray<string> = [];

  constructor(
    private readonly layout: Pick<LayoutState, 'findEdge'>,
    private readonly trains: Pick<
      TrainRoster,
      'get' | 'values' | 'trainsBlocking' | 'markerHeldByAnotherTrain'
    >,
    private readonly clearance: ClearanceRetry,
  ) {}

  reset(): void {
    this.currentDeadlock = [];
  }

  /**
   * Detect a waits-for cycle and, if one exists, try to resolve it by yielding
   * the lowest-ranked train in the cycle (ADR-017 §3) before publishing the
   * deadlock state.
   *
   * Resolution stays entirely within the clearance model. The victim — the
   * lowest-ranked train in the cycle under the same total order (§1) — has the
   * held edge that blocks its higher-ranked cycle peer RELEASED, and the victim
   * is added to the retry skip set so it cannot immediately re-grab the block
   * it was just told to release (the same mechanism `revokeClearance` uses).
   * The higher-ranked peers then proceed and the cycle breaks. The yield runs
   * ONCE per pass and re-runs only the per-train grant loop (victim skipped),
   * never re-entering detection, so this cannot recurse.
   *
   * Load-bearing honesty (ADR-017): a yield only unwinds the deadlock if the
   * victim has NOT physically entered the contested block — it is still waiting
   * at a boundary it merely holds (the passing-loop case). If the victim is
   * already stopped INSIDE the section the winner needs (a nose-to-nose
   * standoff), withholding changes nothing and there is no held edge to release
   * that would free the winner; we do NOT yield, and the deadlock state is
   * published unchanged. Detection stays honest where resolution cannot reach.
   */
  resolveOrEmitState(skipTrainIds?: ReadonlySet<string>): ReadonlyArray<SchedulerEffect> {
    const cycle = this.detectWaitsForCycle();
    if (cycle && skipTrainIds === undefined) {
      /* First try the FORWARD cure (ADR-017 §3): withhold the lowest-ranked
       * victim's not-yet-entered claims so a peer takes the freed block. That
       * reaches every standoff EXCEPT the physically-closed one — a train
       * stopped INSIDE the block a peer needs, which a withhold cannot vacate. */
      const yielded = this.tryYieldLowestRanked(cycle);
      if (yielded) return yielded;
      /* The forward cure could not fire: this is a closed nose-to-nose standoff.
       * Try REVERSE authority (ADR-022) — back the lowest-ranked train that has
       * a safe retreat out of the occupied block so the peer can proceed. If no
       * cycle member can safely reverse, this returns null and the deadlock is
       * reported unchanged. */
      const reversed = this.tryReverseToBreakStandoff(cycle);
      if (reversed) return reversed;
    }
    return this.emitDeadlockState(cycle);
  }

  /**
   * Publish the `railway/state/deadlock/active` retained snapshot, but only
   * when the deadlock set actually changes — `retryBlockedClearances` fires
   * from many handlers and we don't want to thrash the topic. An empty list
   * clears the banner once the cycle is gone.
   */
  private emitDeadlockState(cycle: ReadonlyArray<string> | null): ReadonlyArray<SchedulerEffect> {
    const sorted = cycle ? [...cycle].sort() : [];
    if (
      sorted.length === this.currentDeadlock.length &&
      sorted.every((t, i) => t === this.currentDeadlock[i])
    ) {
      return [];
    }
    this.currentDeadlock = sorted;
    return [effects.updateState('deadlock', 'active', { trains: sorted })];
  }

  /**
   * Pick the lowest-ranked train in the cycle and, if it can still yield,
   * release the held edge that is blocking its higher-ranked peer, then re-run
   * the grant loop with the victim skipped so the peer takes the freed block.
   * Returns the resolving effects, or `null` if no yield is possible (the
   * nose-to-nose case) — in which case the caller publishes the deadlock state
   * unchanged.
   */
  private tryYieldLowestRanked(
    cycle: ReadonlyArray<string>,
  ): ReadonlyArray<SchedulerEffect> | null {
    const victim = this.lowestRankedInCycle(cycle);
    if (!victim) return null;

    /* The peer the victim blocks: the next train round the cycle, which wants
     * an edge the victim currently holds. Find the victim's held edges that
     * share a marker with that peer's wanted edge — those are what to release.
     * If the victim has nothing held to release for the peer (it is occupying,
     * not merely holding-ahead, the contested block) the yield cannot help. */
    const peerWanted = this.peerWantedEdgeBlockedByVictim(cycle, victim);
    if (!peerWanted) return null;

    /* The block the victim physically OCCUPIES is the held edge whose
     * `to_marker_id` is the victim's last reported marker — its head sits at
     * that marker, tail trailing back along that edge. (NOT `current_edge`,
     * which is the NEXT, not-yet-entered edge at `progress_index` — for a
     * waiting train that edge is by definition ungranted, so guarding it is a
     * no-op.) The occupied block cannot be vacated by a withhold: the train is
     * sitting on it and our model has no reverse authority to back it out
     * (ADR-017 load-bearing constraint). Everything ELSE the victim holds
     * (deeper tail blocks, grant-ahead claims) is clearance it can release. */
    const occupiedMarker = victim.last_marker_id;
    const releasable = victim.cleared_edges.filter(
      (held) => edgeSharesMarker(held, peerWanted) && held.to_marker_id !== occupiedMarker,
    );
    if (releasable.length === 0) return null;

    /* Honesty guard (ADR-017): only yield if releasing those blocks would
     * ACTUALLY free the peer. If, after releasing every block it legally can,
     * the victim's REMAINING held edges (its occupied head block) still share a
     * marker with the peer's wanted edge, the peer stays blocked — this is the
     * physically-closed standoff the clearance model cannot cure. Don't issue a
     * useless revoke that would falsely look "resolved"; report the deadlock. */
    const remainingAfterYield = victim.cleared_edges.filter(
      (held) => !releasable.some((r) => edgesEqual(r, held)),
    );
    if (anyEdgeSharesMarker(remainingAfterYield, peerWanted)) return null;

    victim.cleared_edges = remainingAfterYield;
    if (victim.last_marker_id !== undefined) {
      victim.clearance_limit_marker_id = victim.last_marker_id;
    }

    const out: SchedulerEffect[] = [
      effects.sendCommand(victim.train_id, 'revoke_clearance', {
        reason: 'deadlock_yield',
        immediate: true,
      }),
      clearanceStateEffect(victim),
    ];
    /* Re-run the grant loop with the victim skipped so it cannot re-grab the
     * block it just yielded, letting the higher-ranked peers proceed. This
     * recurses into retryBlockedClearances exactly once with a non-undefined
     * skip set, so the yield branch is not re-entered. */
    out.push(...this.clearance.retryBlockedClearances(new Set([victim.train_id])));
    return out;
  }

  /** The lowest-ranked train in the cycle under the total order (§1). */
  private lowestRankedInCycle(cycle: ReadonlyArray<string>): TrainState | undefined {
    let worst: TrainState | undefined;
    for (const id of cycle) {
      const train = this.trains.get(id);
      if (!train) continue;
      if (!worst || compareTrains(worst, train) < 0) worst = train;
    }
    return worst;
  }

  /**
   * The wanted edge of the cycle peer immediately downstream of the victim —
   * i.e. the train the victim is blocking. In the waits-for cycle order, the
   * train BEFORE the victim waits-for the victim; that predecessor's wanted
   * edge is what the victim's held block denies. Returns `undefined` if no such
   * peer/edge can be resolved.
   */
  private peerWantedEdgeBlockedByVictim(
    cycle: ReadonlyArray<string>,
    victim: TrainState,
  ): EdgeRef | undefined {
    const waiting = this.collectWaitingTrains();
    const victimIndex = cycle.indexOf(victim.train_id);
    if (victimIndex === -1) return undefined;
    /* Whoever in the cycle waits-for the victim: scan all cycle members for one
     * whose wanted edge shares a marker with an edge the victim holds. */
    for (const id of cycle) {
      if (id === victim.train_id) continue;
      const wanted = waiting.get(id);
      if (!wanted) continue;
      if (anyEdgeSharesMarker(victim.cleared_edges, wanted)) return wanted;
    }
    return undefined;
  }

  /**
   * ADR-022 — REVERSE authority. The closed nose-to-nose standoff the forward
   * yield (ADR-017 §3) cannot cure: a train stopped INSIDE the block a peer
   * needs. Withholding does nothing; the only cure is to back the train OUT.
   *
   * Walk the cycle members in the SAME total order (§1), lowest-ranked first —
   * the lowest-ranked train gives ground, exactly as it is the one withheld in
   * the forward case. For each candidate compute a safe backward target X
   * (`computeReverseTarget`): the first marker behind its head reached only over
   * track it provably holds, at which its remaining occupancy no longer shares
   * with the peer's wanted edge. The first candidate with such an X is the
   * reverser; if none has one (no safe retreat for anyone — a buffer behind
   * every head, or every retreat still contests), return null and the caller
   * reports the deadlock unchanged. Deterministic: order + graph query only.
   */
  private tryReverseToBreakStandoff(
    cycle: ReadonlyArray<string>,
  ): ReadonlyArray<SchedulerEffect> | null {
    /* Candidates in the total order, lowest-ranked first (the inverse of
     * `orderedTrains`' preferred-first sort): the train that should give ground. */
    const candidates = cycle
      .map((id) => this.trains.get(id))
      .filter((t): t is TrainState => t !== undefined)
      .sort((a, b) => compareTrains(b, a));

    for (const victim of candidates) {
      const peerWanted = this.peerWantedEdgeBlockedByVictim(cycle, victim);
      if (!peerWanted) continue;
      const plan = this.computeReverseTarget(victim, peerWanted);
      if (!plan) continue;
      return this.enactReverse(victim, plan);
    }
    return null;
  }

  /**
   * The safety check and the "how far back" computation, as one walk (ADR-022
   * §3). For `victim` blocking `peerWanted`, walk backward from the head over
   * the edges the victim HOLDS, looking for a target marker X such that:
   *   (a) every edge backed over is one the victim holds (so no peer can be
   *       inside it — block exclusivity guarantees that) AND the new-head marker
   *       it lands on is shared by no OTHER train's held edges (provably clear);
   *   (b) once the head sits at X, the victim's REMAINING held edges (those from
   *       X backward — its tail) no longer share a marker with `peerWanted`.
   * Returns the target marker and the ordered run of held edges to release (the
   * blocks vacated, head-first), or `undefined` if no safe X exists (a buffer
   * behind the head, or every retreat still contests the peer's marker).
   *
   * Pure graph + occupancy query over scheduler-held state; no clock, no RNG.
   */
  private computeReverseTarget(
    victim: TrainState,
    peerWanted: EdgeRef,
  ): { targetMarkerId: string; releasedEdges: ReadonlyArray<EdgeRef> } | undefined {
    const head = victim.last_marker_id;
    if (head === undefined) return undefined;

    const released: EdgeRef[] = [];
    const visited = new Set<string>([head]);
    let boundary = head;

    /* Bounded by the number of held edges — the train can retreat at most over
     * every block it holds; the visited-marker guard prevents looping on cyclic
     * topologies where the held edges form a ring. */
    for (let step = 0; step < victim.cleared_edges.length; step++) {
      /* The block the head currently sits at the END of: the held edge whose
       * to_marker is the current boundary. Backing over it retreats the head to
       * that edge's from_marker. */
      const headBlock = victim.cleared_edges.find((e) => e.to_marker_id === boundary);
      if (!headBlock) break; // buffer / terminus: no held edge behind the head.

      const nextMarker = headBlock.from_marker_id;
      if (visited.has(nextMarker)) break; // would loop; stop conservatively.

      /* (a) the marker we'd back onto must be provably clear — no OTHER train
       * holds an edge touching it. (Backing over `headBlock` itself is safe by
       * exclusivity: the victim holds it, so no peer is inside it.) */
      if (this.trains.markerHeldByAnotherTrain(victim.train_id, nextMarker)) break;

      released.push(headBlock);
      visited.add(nextMarker);
      boundary = nextMarker;

      /* (b) after retreating to `boundary`, do the victim's REMAINING held edges
       * still contest the peer's wanted edge? Remaining = everything not yet
       * released. The first boundary at which they no longer share is X. */
      const remaining = victim.cleared_edges.filter(
        (held) => !released.some((r) => edgesEqual(r, held)),
      );
      if (!anyEdgeSharesMarker(remaining, peerWanted)) {
        /* (c) LENGTH SAFETY (ADR-022 + ADR-012/016). Backing the HEAD from its old
         * position to X shifts the whole body back by the same distance: the TAIL
         * sweeps into the track BEHIND X. The body extends
         * `length_mm` behind X and that swept region must be track the victim still
         * provably HOLDS (so block exclusivity keeps it locked and no peer is
         * granted into a block the reverser physically sits on). The scheduler only
         * knows the occupancy it tracks in `cleared_edges`; if the body would reach
         * past the retained tail into edges it does NOT hold (or whose length is
         * unknown), the swept region cannot be proven clear+held, so this candidate
         * is REFUSED — report, never force an unsafe reverse. Mirrors
         * `collectTailReleases`' conservative backward length walk and its
         * hold-don't-guess asymmetry. */
        if (this.reverseBodyCoveredByHeldTail(victim, boundary, remaining)) {
          return { targetMarkerId: boundary, releasedEdges: released };
        }
        /* The body sweeps past tracked occupancy at this X. A deeper X only puts
         * the head further back and the tail further still — never better — so no
         * safe target exists for this victim; refuse and let the caller try the
         * next candidate. */
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Length-safety for a reverse to `targetMarkerId` (X). After the reverse the
   * victim's head sits at X and its body extends `length_mm` BACK along the rail.
   * That swept-behind region must lie entirely within edges the victim still HOLDS
   * (`retainedEdges` — its tail), so block exclusivity protects it and no peer is
   * granted into track the reverser physically occupies.
   *
   * Walk backward from X through the retained held edges, chaining `to_marker_id`
   * links and summing `estimated_length_mm`, until the accumulated distance
   * reaches `length_mm`. If at any step there is no retained held edge behind the
   * current boundary, or its length is unknown, the body would extend into track
   * the scheduler does not track as held / cannot measure → return false (refuse).
   *
   * Pure graph + occupancy query; no clock, no RNG. The visited-marker guard plus
   * the retained-edge-count bound guarantee termination on cyclic topologies.
   */
  private reverseBodyCoveredByHeldTail(
    victim: TrainState,
    targetMarkerId: string,
    retainedEdges: ReadonlyArray<EdgeRef>,
  ): boolean {
    const lengthMm = victim.length_mm;

    let boundary = targetMarkerId;
    let covered = 0;
    const visited = new Set<string>([boundary]);
    for (let step = 0; step < retainedEdges.length && covered < lengthMm; step++) {
      const tailEdge = retainedEdges.find((e) => e.to_marker_id === boundary);
      if (!tailEdge) return false; // body extends past held track — cannot prove occupancy.

      const edgeLength = this.layout.findEdge(
        tailEdge.from_marker_id,
        tailEdge.to_marker_id,
      )?.estimated_length_mm;
      if (edgeLength === undefined) return false; // unknown length — never guess to grant.

      covered += edgeLength;
      if (visited.has(tailEdge.from_marker_id)) break; // ring of held edges; bounded above.
      visited.add(tailEdge.from_marker_id);
      boundary = tailEdge.from_marker_id;
    }
    return covered >= lengthMm;
  }

  /**
   * Enact a reverse grant (ADR-022 §4). Release the vacated blocks from the
   * victim's `cleared_edges` (retaining the edges from X backward it still sits
   * on — its tail), re-anchor its head and clearance limit at X, emit the
   * `grant_reverse` command + clearance snapshot, then re-run the grant loop
   * with the victim skipped so the now-freed block lets the peer proceed and
   * the victim cannot immediately re-grab what it just vacated.
   */
  private enactReverse(
    victim: TrainState,
    plan: { targetMarkerId: string; releasedEdges: ReadonlyArray<EdgeRef> },
  ): ReadonlyArray<SchedulerEffect> {
    victim.cleared_edges = victim.cleared_edges.filter(
      (held) => !plan.releasedEdges.some((r) => edgesEqual(r, held)),
    );
    victim.last_marker_id = plan.targetMarkerId;
    victim.clearance_limit_marker_id = plan.targetMarkerId;
    this.rewindTransitForReverse(victim, plan.releasedEdges);
    victim.reversing = {
      target_marker_id: plan.targetMarkerId,
      path_marker_ids: plan.releasedEdges.flatMap((e) => [e.from_marker_id, e.to_marker_id]),
    };

    const out: SchedulerEffect[] = [
      effects.sendCommand(victim.train_id, 'grant_reverse', {
        limit_marker_id: plan.targetMarkerId,
        edges: plan.releasedEdges,
        reason: 'deadlock_reverse',
      }),
      clearanceStateEffect(victim),
    ];
    out.push(...this.clearance.retryBlockedClearances(new Set([victim.train_id])));
    return out;
  }

  /**
   * After a reverse the train's head is back at the target marker, so the blocks
   * it vacated are AHEAD of it again. Put them back at the front of its transit
   * (in driving order) and point its heading at the first of them: the horizon
   * then grants from the head outward, and the train can never be cleared onto
   * track beyond the vacated blocks while it still has to drive back over them.
   * `vacatedHeadFirst` is the reverse plan's released run, head block first.
   */
  private rewindTransitForReverse(
    train: TrainState,
    vacatedHeadFirst: ReadonlyArray<EdgeRef>,
  ): void {
    const vacated = [...vacatedHeadFirst].reverse();
    const firstVacated = vacated[0];
    if (firstVacated === undefined) return;
    train.current_edge = firstVacated;
    if (!train.transit) return;
    train.transit = {
      edges: [...vacated, ...train.transit.edges.slice(train.transit.progress_index)],
      progress_index: 0,
    };
  }

  /**
   * Build the waits-for graph over currently-blocked trains and return any
   * one cycle in it (as a list of train IDs in cycle order), or null if no
   * cycle exists.
   *
   * A train is "waiting" if it has a transit, has a next edge to traverse,
   * and that edge is not yet in its `cleared_edges`. A train T waits-for
   * another train T' when any edge T' holds shares a marker with T's wanted
   * edge — i.e. the section-pair rule denies T because T' is in the way.
   */
  private detectWaitsForCycle(): ReadonlyArray<string> | null {
    const waiting = this.collectWaitingTrains();
    if (waiting.size < 2) return null;
    const waitsFor = this.buildWaitsForGraph(waiting);
    return findCycleStartingFromAny(waiting.keys(), waitsFor);
  }

  /**
   * Trains that have a transit, have a next edge to traverse, and that
   * edge isn't yet in their `cleared_edges`. They're the candidates for
   * a waits-for cycle.
   */
  private collectWaitingTrains(): Map<string, EdgeRef> {
    const waiting = new Map<string, EdgeRef>();
    for (const train of this.trains.values()) {
      /* Cross-feature safety (ADR-019 × ADR-017): a topology-held train is NOT
       * waiting on clearance contention — it is waiting on operator recovery
       * (reanchor / confirmNewTrack). It satisfies the structural waiting test
       * (it has a transit, its progress_index was deliberately NOT advanced by
       * handleTopologyViolation, and its next edge is uncleared), so without
       * this guard it would enter the waits-for graph. There it is doubly
       * dangerous: it could be reported in a spurious deadlock, and — being
       * pinned at P (last_marker_id) while it holds the phantom guard edge
       * {P->M} (to_marker_id = M != P) over its uncertain-position region — the
       * deadlock yield would classify that guard as a releasable hold-ahead
       * claim and hand the region to a peer, vacating the very block that keeps
       * the train's unknown position default-safe. Excluding it keeps it out of
       * the graph entirely: it can never be a yield victim and never produce a
       * false deadlock. A peer contending for its region stays correctly blocked
       * (the region is genuinely locked) — just with no false deadlock report. */
      if (train.block_reason === 'unknown_topology') continue;
      if (!train.transit) continue;
      const nextEdge = train.transit.edges[train.transit.progress_index];
      if (!nextEdge) continue;
      if (train.cleared_edges.some((e) => edgesEqual(e, nextEdge))) continue;
      waiting.set(train.train_id, nextEdge);
    }
    return waiting;
  }

  /**
   * For each waiting train, the set of trains whose currently-held edges
   * share a boundary marker with the train's wanted edge — i.e. the
   * trains denying it clearance under the section-pair rule.
   */
  private buildWaitsForGraph(
    waiting: ReadonlyMap<string, EdgeRef>,
  ): Map<string, ReadonlyArray<string>> {
    const graph = new Map<string, ReadonlyArray<string>>();
    for (const [trainId, wanted] of waiting) {
      graph.set(trainId, this.trains.trainsBlocking(trainId, wanted));
    }
    return graph;
  }
}

/**
 * Iterative DFS for a cycle in the waits-for graph that returns to one of
 * the start nodes. Returns the cycle as an ordered list of train IDs, or
 * null if none exists.
 */
function findCycleStartingFromAny(
  starts: Iterable<string>,
  graph: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> | null {
  for (const start of starts) {
    const found = dfsForCycleBackToStart(start, graph);
    if (found) return found;
  }
  return null;
}

function dfsForCycleBackToStart(
  start: string,
  graph: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> | null {
  const stack: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    for (const next of graph.get(frame.node) ?? []) {
      if (next === start && frame.path.length >= 2) return frame.path;
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push({ node: next, path: [...frame.path, next] });
    }
  }
  return null;
}
