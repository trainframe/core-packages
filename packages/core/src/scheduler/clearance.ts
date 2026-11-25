import type { DeviceTable } from './devices.js';
import {
  type SchedulerEffect,
  clearanceStateEffect,
  effects,
  grantClearancePayload,
} from './effects.js';
import type { LayoutState } from './layout-state.js';
import type { SwitchControl } from './switches.js';
import type { TrainRoster } from './train-roster.js';
import { type TrainState, leaveStandingBlock } from './train-state.js';
import { type EdgeRef, edgesEqual } from './types.js';

/**
 * How many edges of clearance the scheduler keeps granted AHEAD of the edge a
 * train is currently on — the clearance HORIZON. Granted proactively (topped up
 * on every marker crossing and after any retry) rather than one edge at a time
 * when the train reaches its limit, so a moving train always has several blocks
 * of room in front of it and never has to brake to a stop approaching a
 * limit-marker that's only one block ahead.
 *
 * Three is enough to absorb the simulator's braking distance on the demo loop
 * while staying small enough that the single-direction oval never over-locks: a
 * chaser only ever needs to wait one block behind the leader's lock set, and the
 * conflict check in `tryGrantClearance` runs BEFORE switch actuation, so a
 * longer look-ahead can never flip points out from under a peer that already
 * holds a junction. If a future topology deadlocks under N=3, lower it — it is a
 * tuning floor, not a contract.
 *
 * This is the FLOOR of the horizon. When learned per-edge traversal times are
 * available (`LayoutState.getLearnedTraversalMs`), the horizon grows ABOVE this
 * floor so that the cleared-ahead edges cover at least `CLEARANCE_LEAD_TIME_MS`
 * of learned transit (see `extendHorizon`) — never shrinking below the
 * floor, never exceeding `CLEARANCE_HORIZON_MAX_EDGES`.
 */
export const CLEARANCE_HORIZON_EDGES = 3;

/**
 * Target LEAD TIME, in milliseconds, the clearance horizon aims to keep granted
 * ahead of a moving train once learned per-edge traversal times exist. The
 * horizon walks forward granting edges until the cumulative learned traversal
 * time of the cleared-ahead edges meets this target (or the edge-count
 * `CLEARANCE_HORIZON_MAX_EDGES` ceiling is hit).
 *
 * Why time, not edge count: a fixed edge count gives wildly different lead
 * *time* on a layout of mixed edge speeds. A handful of short/fast edges may be
 * a second of warning; the same count of long/slow edges may be many. Pinning
 * the horizon to a lead TIME makes the train carry a consistent reaction buffer
 * regardless of the physical block sizes — fast/short edges pull MORE blocks of
 * clearance forward (so the train still has the same seconds of room), and the
 * train learns to clear earlier on the parts of the layout that historically
 * move quickly. The slow/long edges that prompted this feature already carry
 * enough lead time in a single block, so the horizon does not over-extend there.
 *
 * Set to 6000 ms: comfortably above the simulator's per-edge transit on the demo
 * loops at the floor of 3 edges (so short layouts stay at the floor until
 * learning kicks in), while bounded by the edge ceiling so it can never
 * over-lock.
 */
export const CLEARANCE_LEAD_TIME_MS = 6_000;

/**
 * Hard ceiling on the clearance horizon, in edges. The time-aware horizon
 * (`CLEARANCE_LEAD_TIME_MS`) can pull more than `CLEARANCE_HORIZON_EDGES` blocks
 * forward on fast/short edges, but never more than this — a longer look-ahead
 * risks over-locking a small loop (the same concern that fixes the floor at 3).
 */
export const CLEARANCE_HORIZON_MAX_EDGES = 6;

/**
 * Granting and releasing clearance for one train at a time: the proactive
 * horizon ahead of a moving train, a train's own `clearance_request`, the
 * block-exclusivity, switch and capability checks every grant passes, and the
 * length-aware tail release. Deciding WHEN to re-run the horizon for every
 * train is the caller's.
 */
export class ClearanceControl {
  constructor(
    private readonly layout: Pick<LayoutState, 'findEdge' | 'hasMarker' | 'getLearnedTraversalMs'>,
    private readonly trains: Pick<TrainRoster, 'get' | 'edgeConflictsWithAnotherTrain'>,
    private readonly switches: Pick<SwitchControl, 'edgeRequiresMismatchedSwitch' | 'actuate'>,
    private readonly devices: Pick<DeviceTable, 'anyCapabilityDenies'>,
  ) {}

  /**
   * Grant clearance PROACTIVELY ahead of the edge the train is currently on.
   * Walks forward from `transit.progress_index`, granting any edge not yet
   * held, until the horizon is satisfied or an edge can't be granted.
   *
   * The horizon is LEARNED-TIME-AWARE. The naive model held a fixed
   * `CLEARANCE_HORIZON_EDGES` blocks regardless of how long each block takes to
   * traverse, which gives inconsistent lead *time* across a layout of mixed edge
   * speeds. Here, once `LayoutState.getLearnedTraversalMs` has accumulated a
   * per-edge EWMA, we keep granting until the cleared-ahead edges cover at least
   * `CLEARANCE_LEAD_TIME_MS` of learned transit — clamped to never grant fewer
   * than `CLEARANCE_HORIZON_EDGES` (the floor that the existing braking-distance
   * behaviour depends on) nor more than `CLEARANCE_HORIZON_MAX_EDGES` (the
   * over-lock ceiling). See `horizonSatisfied`.
   *
   * Net effect: on a stretch the train has learned to cross quickly, the horizon
   * pulls more blocks forward so the train still carries the same seconds of
   * room and starts clearing earlier; on a long/slow edge a single block already
   * covers the lead time, so the horizon stays at the floor. Edges with NO
   * learned time yet are treated as covering the full lead time (a conservative
   * default — we never speculatively over-extend into territory whose transit we
   * have not measured), so an un-learned layout holds a fixed-floor horizon
   * until trains have actually run and learned the timings.
   *
   * Counting rule: edges already in `cleared_edges` count toward the horizon
   * (they're clearance the train still holds ahead of it) but are skipped, not
   * re-granted, and their learned time still accumulates toward the lead-time
   * target.
   *
   * STOP-ON-GAP (load-bearing): if `tryGrantClearance` returns no grant for an
   * edge — a peer-held conflict (ADR-011), a gate denial, or a switch that must
   * first be actuated (which only *requests* the switch and withholds) — we stop
   * immediately and never grant a later edge across the gap. This is what
   * preserves block exclusivity, the length-aware switched-junction
   * serialization, and the autonomous switch-throw: the horizon reaching a
   * junction's divert/main edge requests the switch early, then stalls there
   * until `switch_state_changed` → `retryBlockedClearances` resumes the walk.
   */
  extendHorizon(train: TrainState): ReadonlyArray<SchedulerEffect> {
    /* ADR-036 defence-in-depth: never extend clearance for a not-yet-introduced
     * train. It has no resolved vector and must not be granted any onward block.
     * This is normally unreachable (such a train has no `transit`), but the
     * explicit guard makes the invariant local rather than transitive. */
    if (!train.introduced) return [];
    if (!train.transit) return [];
    const out: SchedulerEffect[] = [];
    let granted = 0;
    let accumulatedMs = 0;
    for (
      let i = train.transit.progress_index;
      i < train.transit.edges.length && !this.horizonSatisfied(granted, accumulatedMs);
      i++
    ) {
      const edge = train.transit.edges[i];
      if (!edge) break;
      /* Unknown traversal time → treat the edge as covering the FULL lead time.
       * The horizon then only extends past the floor when learned-fast edges
       * keep the running total below the target; an un-measured edge is assumed
       * to carry enough lead time on its own, so we never over-extend into
       * territory we have not learned. */
      const learnedMs =
        this.layout.getLearnedTraversalMs(edge.from_marker_id, edge.to_marker_id, train.train_id) ??
        CLEARANCE_LEAD_TIME_MS;
      if (train.cleared_edges.some((e) => edgesEqual(e, edge))) {
        // Already held — counts toward the horizon (count and learned time), no
        // re-grant.
        granted++;
        accumulatedMs += learnedMs;
        continue;
      }
      const effects = this.tryGrantClearance(train, edge);
      out.push(...effects);
      // No grant came back: a conflict, a denial, or a switch-actuate-and-hold.
      // Stop — granting a later edge across this gap would defeat block
      // exclusivity and the junction serialization.
      if (!effects.some((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance')) {
        break;
      }
      granted++;
      accumulatedMs += learnedMs;
    }
    return out;
  }

  /**
   * Has the clearance horizon been satisfied after granting `granted` edges
   * ahead, covering `accumulatedMs` of learned transit?
   *
   * Floor: never satisfied below `CLEARANCE_HORIZON_EDGES` edges — the existing
   * braking-distance behaviour relies on always carrying at least that many
   * blocks. On a cold layout every edge is un-learned and so counted at the full
   * `CLEARANCE_LEAD_TIME_MS` (see `extendHorizon`), so the lead-time
   * target is met the moment the floor is reached and the horizon stops exactly
   * there.
   *
   * Ceiling: always satisfied at `CLEARANCE_HORIZON_MAX_EDGES` edges, regardless
   * of accumulated time — the over-lock guard.
   *
   * Between floor and ceiling: satisfied once the learned lead time meets
   * `CLEARANCE_LEAD_TIME_MS`. A fast/short stretch (small per-edge ms) keeps
   * pulling blocks forward until the seconds-of-room target is met.
   */
  private horizonSatisfied(granted: number, accumulatedMs: number): boolean {
    if (granted < CLEARANCE_HORIZON_EDGES) return false;
    if (granted >= CLEARANCE_HORIZON_MAX_EDGES) return true;
    return accumulatedMs >= CLEARANCE_LEAD_TIME_MS;
  }

  /**
   * A train asks for clearance onto `next_edge`. Only the train itself may ask
   * (the sending device must be the named train), and only for an edge on its
   * planned route ahead of it. The route is granted IN ORDER up to that edge,
   * stopping at the first edge that cannot be granted, so a request can never
   * open clearance across a gap the horizon walk refused (block exclusivity, a
   * gate, or a switch still moving).
   */
  handleClearanceRequest(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { train_id, next_edge } = payload as { train_id: string; next_edge: EdgeRef };

    if (deviceId !== train_id) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `clearance_request for ${train_id} sent by another device (${deviceId}); ignored`,
        }),
      ];
    }

    const missing = this.unknownMarkersInEdges([next_edge]);
    if (missing.length > 0) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `clearance_request from ${train_id} references unknown marker(s): ${missing.join(', ')}`,
        }),
      ];
    }

    const train = this.trains.get(train_id);
    if (!train) return [];

    /* ADR-036: a not-yet-introduced train has no known vector — never grant it
     * clearance, even if it (erroneously) sends a clearance_request. */
    if (!train.introduced) return [];

    const requestedIndex = this.routeIndexAhead(train, next_edge);
    if (requestedIndex === undefined) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `clearance_request from ${train_id} for ${next_edge.from_marker_id}->${next_edge.to_marker_id}, which is not on its route ahead; ignored`,
        }),
      ];
    }
    return this.grantRouteUpTo(train, requestedIndex);
  }

  /** Index of `edge` in the train's transit at or after its progress point, or
   *  `undefined` when the edge is not on the route ahead of it. */
  private routeIndexAhead(train: TrainState, edge: EdgeRef): number | undefined {
    if (!train.transit) return undefined;
    const { edges, progress_index } = train.transit;
    for (let i = progress_index; i < edges.length; i++) {
      const candidate = edges[i];
      if (candidate && edgesEqual(candidate, edge)) return i;
    }
    return undefined;
  }

  /** Grant the train's route edges in order from its progress point through
   *  `lastIndex`, skipping those already held and stopping at the first refusal. */
  private grantRouteUpTo(train: TrainState, lastIndex: number): ReadonlyArray<SchedulerEffect> {
    if (!train.transit) return [];
    const out: SchedulerEffect[] = [];
    for (let i = train.transit.progress_index; i <= lastIndex; i++) {
      const edge = train.transit.edges[i];
      if (!edge) break;
      if (train.cleared_edges.some((e) => edgesEqual(e, edge))) continue;
      const granted = this.tryGrantClearance(train, edge);
      out.push(...granted);
      if (!granted.some((e) => e.kind === 'send_command' && e.command_type === 'grant_clearance')) {
        break;
      }
    }
    return out;
  }

  /**
   * Return the (deduplicated, ordered) marker IDs referenced by `edges` that
   * are not present in the current layout. Used as a referential-integrity
   * check on event/command payloads at the broker boundary, where we cannot
   * trust inbound MQTT to reference known entities.
   */
  private unknownMarkersInEdges(edges: ReadonlyArray<EdgeRef>): ReadonlyArray<string> {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const edge of edges) {
      for (const markerId of [edge.from_marker_id, edge.to_marker_id]) {
        if (seen.has(markerId)) continue;
        seen.add(markerId);
        if (!this.layout.hasMarker(markerId)) missing.push(markerId);
      }
    }
    return missing;
  }

  /**
   * Decide whether to extend a train's clearance to include the given edge.
   * Consults all capabilities with `onClearanceConsultation` hooks. If any
   * deny, clearance is withheld. Otherwise it's granted.
   *
   * Block exclusivity (ADR-011): a section is an edge plus its two boundary
   * markers; two trains conflict if their edges share any marker. This is
   * what protects crossings (every edge incident to X shares X), junctions,
   * and gives one-block separation on a straight loop — all from one rule.
   */
  private tryGrantClearance(train: TrainState, nextEdge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    if (train.operator_hold) return [];
    // Conflict check FIRST (ADR-011 block exclusivity). This ordering is the
    // invariant that prevents two trains fighting over one switch: a train
    // only reaches the actuation branch once it has exclusive claim to the
    // junction's section, so it cannot flip the points out from under a peer
    // that already holds the junction.
    if (this.trains.edgeConflictsWithAnotherTrain(train.train_id, nextEdge)) return [];
    if (this.switches.edgeRequiresMismatchedSwitch(nextEdge))
      return this.switches.actuate(nextEdge);
    if (this.anyCapabilityDeniesClearance(train, nextEdge)) return [];
    return this.grantClearance(train, nextEdge);
  }

  private anyCapabilityDeniesClearance(train: TrainState, nextEdge: EdgeRef): boolean {
    return this.devices.anyCapabilityDenies({
      train_id: train.train_id,
      current_limit_marker_id: train.clearance_limit_marker_id ?? '',
      proposed_new_limit_marker_id: nextEdge.to_marker_id,
      proposed_edges_to_clear: [nextEdge],
    });
  }

  private grantClearance(train: TrainState, nextEdge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    leaveStandingBlock(train, nextEdge);
    train.clearance_limit_marker_id = nextEdge.to_marker_id;
    train.cleared_edges = [...train.cleared_edges, nextEdge];
    return [
      effects.sendCommand(
        train.train_id,
        'grant_clearance',
        grantClearancePayload(nextEdge.to_marker_id, [nextEdge]),
      ),
      clearanceStateEffect(train),
    ];
  }

  /**
   * Release every held edge the tail of a length-aware train has left behind,
   * given the marker its head last crossed, how far past it the head is and, when
   * the train follows a route, the edge its head is on. Returns whether anything
   * was released.
   */
  releaseTail(
    train: TrainState,
    boundaryMarkerId: string,
    currentEdge: { from_marker_id: string; to_marker_id: string } | undefined,
    distanceMm: number,
  ): boolean {
    const edgesToRelease = this.collectTailReleases(
      train,
      boundaryMarkerId,
      currentEdge,
      distanceMm,
    );
    if (edgesToRelease.length === 0) return false;
    train.cleared_edges = train.cleared_edges.filter(
      (e) => !edgesToRelease.some((r) => edgesEqual(r, e)),
    );
    return true;
  }

  /**
   * Walk backward through `cleared_edges` from the current boundary and
   * collect every edge whose cumulative distance from the head has reached
   * the train's physical length — those edges are now free of the tail.
   *
   * Depth-k boundary is reached by following `to_marker_id` links backward
   * through previously-traversed edges, excluding forward-transit edges
   * (which are ahead, not behind the head). The visited-marker guard plus a
   * max-iteration bound of `cleared_edges.length` ensure termination on cyclic
   * topologies where the train holds every edge of a small loop.
   *
   * Conservative hold: if an intermediate edge's `estimated_length_mm` is
   * undefined the walk stops there. Deeper edges remain held. This asymmetry
   * is deliberate: holding too long is safe, releasing too early is not.
   */
  private collectTailReleases(
    train: TrainState,
    boundaryMarkerId: string,
    currentEdge: { from_marker_id: string; to_marker_id: string } | undefined,
    distanceMm: number,
  ): ReadonlyArray<EdgeRef> {
    const lengthMm = train.length_mm;
    const result: EdgeRef[] = [];
    const forwardEdgeKeys = this.buildForwardEdgeKeys(train, currentEdge);

    const visitedMarkers = new Set<string>();
    let boundaryMarker = boundaryMarkerId;
    let cumulative = distanceMm;

    for (let depth = 0; depth < train.cleared_edges.length; depth++) {
      if (visitedMarkers.has(boundaryMarker)) break;
      visitedMarkers.add(boundaryMarker);

      const chainEdge = train.cleared_edges.find(
        (e) =>
          e.to_marker_id === boundaryMarker &&
          !forwardEdgeKeys.has(`${e.from_marker_id}->${e.to_marker_id}`),
      );
      if (!chainEdge) break;

      if (cumulative >= lengthMm) result.push(chainEdge);

      /* Conservative hold: unknown edge length → cannot compute the cumulative
       * to the next boundary; stop here. Holding deeper edges is always safe. */
      const edgeLength = this.layout.findEdge(
        chainEdge.from_marker_id,
        chainEdge.to_marker_id,
      )?.estimated_length_mm;
      if (edgeLength === undefined) break;

      cumulative += edgeLength;
      boundaryMarker = chainEdge.from_marker_id;
    }

    return result;
  }

  /**
   * Build the set of edge keys that are in the forward transit (at or ahead of
   * the current progress index) plus the current edge. The backward tail-release
   * walk must exclude these to avoid mistaking a future-horizon edge for a
   * past-traversed one on cyclic topologies.
   */
  private buildForwardEdgeKeys(
    train: TrainState,
    currentEdge: { from_marker_id: string; to_marker_id: string } | undefined,
  ): ReadonlySet<string> {
    const keys = new Set<string>();
    if (currentEdge) keys.add(`${currentEdge.from_marker_id}->${currentEdge.to_marker_id}`);
    if (!train.transit) return keys;
    for (let i = train.transit.progress_index; i < train.transit.edges.length; i++) {
      const fe = train.transit.edges[i];
      if (fe) keys.add(`${fe.from_marker_id}->${fe.to_marker_id}`);
    }
    return keys;
  }
}
