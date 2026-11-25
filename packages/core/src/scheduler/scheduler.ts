import type { CapabilityRegistry } from '../registry.js';
import { ClearanceControl } from './clearance.js';
import { DeviceTable, readRegistration } from './devices.js';
import {
  type SchedulerEffect,
  clearanceStateEffect,
  effects,
  grantClearancePayload,
} from './effects.js';
import { IdentityAndTags } from './identity.js';
import type { LayoutState } from './layout-state.js';
import { planTransit } from './planner.js';
import type { MarkerOwnership } from './seams.js';
import { SwitchControl } from './switches.js';
import type { TagRegistry } from './tag-registry.js';
import { TrainRoster, compareTrains } from './train-roster.js';
import type { TrainState } from './train-state.js';
import { type EdgeRef, anyEdgeSharesMarker, edgeSharesMarker, edgesEqual } from './types.js';
import { ZoneAuthority } from './zones.js';

/**
 * Deterministic dwell at a scheduled stop, in milliseconds. When a train
 * arrives at its scheduled stop the scheduler holds it (no onward clearance,
 * no pointer advance) until this much injected-clock time has elapsed, so
 * trains visibly pause at stations. A named constant, not a magic number.
 */
export const STATION_DWELL_MS = 2500;

export {
  CLEARANCE_HORIZON_EDGES,
  CLEARANCE_HORIZON_MAX_EDGES,
  CLEARANCE_LEAD_TIME_MS,
} from './clearance.js';
export { SWITCH_ACTUATION_TIMEOUT_MS } from './switches.js';

export interface SchedulerOptions {
  /**
   * Monotonic clock callback in ms, used to time the station dwell. REQUIRED:
   * core never reads the wall clock directly (determinism contract). The IO
   * layer (`@trainframe/server`) supplies `Date.now`; tests and the simulator
   * inject a virtual clock — mirrors the seam `LayoutState` exposes.
   */
  readonly now: () => number;
}

/**
 * The scheduler. Stateful, but the state is fully observable and all
 * mutations happen through `handleEvent`.
 */
export class Scheduler {
  private readonly devices: DeviceTable;
  private readonly switches: SwitchControl;
  private readonly trains = new TrainRoster();
  private readonly identity: IdentityAndTags;
  private readonly zones: ZoneAuthority;
  private readonly clearance: ClearanceControl;
  /**
   * The set of trains currently part of a detected waits-for cycle (sorted,
   * for stable equality checks). Kept on the scheduler so we only publish a
   * `railway/state/deadlock/active` retained snapshot when the deadlock set
   * actually changes — not on every event.
   */
  private currentDeadlock: ReadonlyArray<string> = [];
  private readonly now: () => number;

  constructor(
    registry: CapabilityRegistry,
    private readonly layout: LayoutState,
    options: SchedulerOptions,
  ) {
    this.now = options.now;
    this.devices = new DeviceTable(registry);
    const ownership: MarkerOwnership = {
      zoneOwnerOf: (markerId) => this.zones.ownerOf(markerId),
      switchOwnerOf: (markerId) => layout.switchDeviceForMarker(markerId),
    };
    this.switches = new SwitchControl(layout, ownership, this.now);
    this.zones = new ZoneAuthority(
      this.devices,
      this.trains,
      ownership,
      { retryBlockedClearances: (skip) => this.retryBlockedClearances(skip) },
      { advanceScheduleAndReplan: (train) => this.advanceScheduleAndReplan(train) },
    );
    this.clearance = new ClearanceControl(layout, this.trains, this.switches, this.devices);
    this.identity = new IdentityAndTags(this.devices, this.trains, layout, {
      handleTrainCrossing: (trainId, markerId) => this.handleTrainCrossing(trainId, markerId),
    });
  }

  /** Read-only view of the tag registry, exposed for the visualiser/tests. */
  getTagRegistry(): TagRegistry {
    return this.identity.getTagRegistry();
  }

  // ---------- public observers (for testing and the visualiser) ----------

  getTrainState(trainId: string): TrainState | undefined {
    return this.trains.get(trainId);
  }

  getTrainIds(): ReadonlyArray<string> {
    return this.trains.ids();
  }

  getDeviceCapabilityState(deviceId: string, capabilityId: string): unknown {
    return this.devices.capabilityState(deviceId, capabilityId);
  }

  getLayout(): LayoutState {
    return this.layout;
  }

  /*
   * Forget all runtime state — trains, devices, tags, deadlock/zone
   * bookkeeping — and revert the layout to its declared baseline. Pure
   * in-memory; the server is responsible for clearing the matching retained
   * broker topics (see Server.reset).
   */
  reset(): void {
    this.trains.clear();
    this.devices.clear();
    this.identity.reset();
    this.currentDeadlock = [];
    this.switches.reset();
    this.zones.reset();
    this.layout.reset();
  }

  // ---------- event entry point ----------

  handleEvent(event: {
    event_type: string;
    device_id: string;
    payload: unknown;
  }): ReadonlyArray<SchedulerEffect> {
    switch (event.event_type) {
      case 'device_registered':
        return this.handleDeviceRegistered(event.device_id, event.payload);
      case 'device_disconnected':
        return this.handleDeviceDisconnect(event.device_id);
      case 'tag_observed':
        return this.identity.handleTagObserved(event.device_id, event.payload);
      case 'clearance_request':
        return this.clearance.handleClearanceRequest(event.device_id, event.payload);
      case 'switch_state_changed':
        return this.handleSwitchStateChanged(event.payload);
      case 'tag_assignment':
        return this.identity.handleTagAssignment(event.device_id, event.payload);
      case 'train_status':
        /* A train waiting at a junction keeps reporting status: that is what
         * gives an unanswered switch command its chance to be re-sent. */
        return [
          ...this.handleTrainStatus(event.device_id, event.payload),
          ...(this.switches.anyRequestOverdue() ? this.retryBlockedClearances() : []),
        ];
      case 'train_length_changed':
        return this.identity.handleTrainLengthChanged(event.device_id, event.payload);
      case 'zone_state_changed':
        return this.handleZoneStateChanged(event);
      case 'zone_train_released':
        return this.zones.handleTrainReleased(event.device_id, event.payload);
      case 'train_introduced':
        return this.handleTrainIntroducedEvent(event.device_id, event.payload);
      default:
        return this.dispatchToCapabilities(event);
    }
  }

  // ---------- device registration ----------

  private handleDeviceRegistered(
    deviceId: string,
    payload: unknown,
  ): ReadonlyArray<SchedulerEffect> {
    const reg = readRegistration(payload);
    const { capabilities } = reg;

    const rejected = this.devices.register(deviceId, reg);
    if (rejected) return [rejected];

    if (capabilities.includes('core.controls_motion')) {
      this.trains.register(deviceId, reg.priority, reg.train_length_mm);
    }

    const ownership: SchedulerEffect[] = [];
    if (capabilities.includes('core.gates_zone')) {
      ownership.push(...this.zones.recordOwnership(deviceId, reg.owned_marker_ids));
    }
    if (capabilities.includes('core.controls_switch')) {
      ownership.push(
        ...this.switches.recordPairing(deviceId, reg.controls_marker_id, reg.valid_positions),
      );
    }

    /* Retained device state. Carries operator-authored name/livery (0.12.0) so a
       display joining after commissioning sees them — they are presentation only,
       never read back by the scheduler. */
    const deviceState: {
      capabilities: string[];
      train_length_mm?: number;
      name?: string;
      livery?: string;
    } = { capabilities };
    if (typeof reg.train_length_mm === 'number' && reg.train_length_mm > 0) {
      deviceState.train_length_mm = reg.train_length_mm;
    }
    if (reg.name !== undefined) deviceState.name = reg.name;
    if (reg.livery !== undefined) deviceState.livery = reg.livery;
    return [...ownership, effects.updateState('devices', deviceId, deviceState)];
  }

  /** The `core.gates_zone` device that owns `markerId` as interior (under its
   *  frame, ADR-034), or undefined if no frame has declared it. */
  ownerOfZoneMarker(markerId: string): string | undefined {
    return this.zones.ownerOf(markerId);
  }

  // ---------- device disconnect ----------

  private handleDeviceDisconnect(deviceId: string): ReadonlyArray<SchedulerEffect> {
    return this.forgetDevice(deviceId);
  }

  /*
   * Remove a device entirely: run each capability's disconnect hook, drop it
   * from the registry and (if it drives motion) the train table, and tombstone
   * its retained state so the visualiser and a freshly-reconnecting broker both
   * forget it. Shared by the `device_disconnected` event and the operator
   * "delete from memory" action so the two paths cannot drift.
   */
  forgetDevice(deviceId: string): ReadonlyArray<SchedulerEffect> {
    const device = this.devices.get(deviceId);
    if (!device) return [];

    const out = this.devices.runDisconnectHooks(device);
    out.push(...this.zones.forgetDevice(deviceId));
    this.switches.forgetDevice(deviceId);
    this.devices.remove(deviceId);
    /*
     * Tombstone the retained device registration. Without this the broker keeps
     * replaying `railway/state/devices/<id>` to every new subscriber and the
     * dead device reappears as "registered, position unknown". An object with
     * no `capabilities` field is the devices view's recognised-empty shape.
     */
    out.push(effects.updateState('devices', deviceId, {}));

    if (device.capabilities.includes('core.controls_motion')) {
      /* Emit empty clearance + schedule snapshots so the visualiser removes
       * the overlay and schedule-list entry for this train. */
      out.push(
        effects.updateState('clearance', deviceId, {
          train_id: deviceId,
          cleared_edges: [],
        }),
        effects.updateState('schedule', deviceId, { train_id: deviceId }),
      );
      this.trains.remove(deviceId);
    }

    out.push(...this.retryBlockedClearances());
    return out;
  }

  // ---------- zone interior handoff (ADR-027) ----------

  /**
   * Record the zone's boundary marker so the scheduler can recognise it (for
   * entry suspension and the reverse-admission gate), then dispatch to the
   * `core.gates_zone` capability as before so admission is unchanged.
   */
  private handleZoneStateChanged(event: {
    event_type: string;
    device_id: string;
    payload: unknown;
  }): ReadonlyArray<SchedulerEffect> {
    this.zones.recordBoundary(event.device_id, event.payload);
    return this.dispatchToCapabilities(event);
  }

  /**
   * Record a marker-to-marker traversal (confirming or learning the edge,
   * ADR-009) and report whether the crossed edge is still inferred. Extracted
   * from `handleTrainAtMarker` to keep that method within the complexity budget.
   */
  private recordTraversalAndDiscovery(
    previousMarker: string | undefined,
    markerId: string,
    trainId: string,
  ): { effects: ReadonlyArray<SchedulerEffect>; inDiscoveryMode: boolean } {
    if (!previousMarker || previousMarker === markerId) {
      return { effects: [], inDiscoveryMode: false };
    }
    const result = this.layout.recordTraversal(previousMarker, markerId, trainId);
    const edge = this.layout.findEdge(previousMarker, markerId);
    const inDiscoveryMode = edge?.inferred ?? false;
    const out: SchedulerEffect[] =
      result.inferredEdgeAdded || result.edgeConfirmed
        ? [effects.updateState('layout', this.layout.name, this.layout.toLayout())]
        : [];
    return { effects: out, inDiscoveryMode };
  }

  /**
   * Route a train's marker crossing. While it is backing up under a reverse
   * grant, a crossing on the vacated path is a reverse crossing. Any other
   * marker means the reverse is over (the train stopped short and moved on), so
   * it is handled as an ordinary crossing.
   */
  private handleTrainCrossing(trainId: string, markerId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (train?.reversing?.path_marker_ids.includes(markerId)) {
      return this.handleReverseCrossing(train, markerId);
    }
    if (train) train.reversing = undefined;
    return this.handleTrainAtMarker(trainId, markerId);
  }

  /**
   * A crossing made while the train is backing up under a `grant_reverse`
   * (ADR-022). Only its position moves: a backward crossing is not a forward
   * traversal of any edge, so it neither learns or confirms an edge, nor
   * advances the transit, nor releases a block (the tail it backs onto is still
   * occupied), nor counts as a topology violation. Reaching the reverse target
   * ends the reverse.
   */
  private handleReverseCrossing(
    train: TrainState,
    markerId: string,
  ): ReadonlyArray<SchedulerEffect> {
    train.last_marker_id = markerId;
    if (train.reversing?.target_marker_id === markerId) train.reversing = undefined;
    return [
      effects.publishEvent('marker_traversed', {
        train_id: train.train_id,
        marker_id: markerId,
        direction: 'reverse',
        in_discovery_mode: false,
      }),
    ];
  }

  /**
   * Update train position and decide whether to extend clearance.
   * The most consequential method in the scheduler.
   */
  private handleTrainAtMarker(trainId: string, markerId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];

    // A train suspended inside a zone (ADR-027) is in the device's opaque
    // interior; core does not track its position there. Ignore any marker it
    // reports until the owning device releases it.
    if (train.in_zone !== undefined) return [];

    /* ADR-036 introduction roll: a not-yet-introduced train that is currently
     * rolling for vector resolution. Intercept BEFORE normal transit/discovery
     * logic so its crossings are never treated as routed-transit progress. */
    if (!train.introduced && train.introducing) {
      return this.handleIntroductionRollMarker(train, markerId);
    }

    /* A not-yet-introduced train that is NOT on an introduction roll still has
     * its crossing OBSERVED here (topology validation, edge learning via
     * `recordTraversal`, the `marker_traversed` emission, exploration
     * continuation). This is required for learn-mode / discovery (ADR-014/015),
     * where an exploring train is deliberately not-introduced yet must teach the
     * graph as it rolls. ADR-036 gates ROUTING and CLEARANCE, not OBSERVATION:
     * such a train has no `transit` (it is never planned — `planAndExecuteCurrentTransit`
     * is gated on `introduced`), so `advanceTransitAndReplanIfReached` is a no-op,
     * and `ClearanceControl.extendHorizon`/`retryBlockedClearances` early-return for a
     * not-introduced train — so nothing here routes it or grants it clearance. */

    const previousMarker = train.last_marker_id;

    /* ADR-019 position validation, BEFORE we advance `last_marker_id`, release
     * any block, or call `recordTraversal` (all of which today implicitly trust
     * the report). P = previousMarker (last certain position), M = markerId.
     *   1. P undefined            → first report, nothing to validate; anchor M.
     *   2. M == P                 → re-read of the current marker; fall through
     *                               (advanceTransit is a no-op, no traversal).
     *   3. edge P→M exists        → normal traversal; proceed as today.
     *   4. edge P→M absent, OPEN  → discovery: recordTraversal learns it (ADR-009).
     *   5. edge P→M absent, EXPECTING (bounded route+clearance) → topology
     *      violation: do NOT learn, hold, flag. Early return — `last_marker_id`
     *      is deliberately left at P (the last position we can vouch for). */
    const violation = this.detectTopologyViolation(train, previousMarker, markerId);
    if (violation) {
      return this.handleTopologyViolation(train, violation.lastKnownMarkerId, markerId);
    }

    train.last_marker_id = markerId;
    // The train has moved on under its own current_edge now; the saved zone
    // arrival heading is stale.
    train.zone_entry_edge = undefined;

    /* Zone entry (ADR-027): an admitted train reaching a zone boundary as its
     * route terminus is pulling into the device's interior. Suspend it here,
     * before the normal release/horizon logic — it parks at the throat and is
     * handed to the device until released. A pass-through train (boundary is
     * not its terminus) is untouched and continues normally. */
    if (this.zones.isEntry(train, markerId)) {
      return this.zones.enter(train, markerId);
    }

    /* `block_reason` is NOT cleared here. A topology hold is lifted ONLY by an
     * explicit operator recovery gesture (`reanchor` / `confirmNewTrack`,
     * ADR-019 §6), never auto-cleared by the train's next report — that would be
     * the auto-re-anchor §6 and the deferred follow-ups explicitly refuse. A
     * held train is stopped on the wire anyway, so it emits no further reports
     * until recovery. */
    const scheduleReplanEffects = this.advanceTransitAndReplanIfReached(train, markerId);

    // Release the block this train has now finished. ADR-002 block exclusivity
    // gates concurrent occupation, not lifetime ownership — without pruning,
    // cleared_edges grows monotonically and every following train is denied.
    //
    // For trains with a known physical length (length_mm > 0), skip immediate
    // release on head arrival. The tail still occupies the section behind the
    // head. Release is deferred until handleTrainStatus reports progress far
    // enough that the tail has vacated each held edge. Multi-edge spanning is
    // supported: handleTrainStatus walks back through cleared_edges and releases
    // every edge whose cumulative distance from the head exceeds length_mm (ADR-012
    // refinement, ADR-016 step 5).
    //
    // SWITCHED-JUNCTION SAFETY: continuous junction protection across a switch
    // handover relies on this tail-occupancy deferral. When a train must cross
    // a junction it doesn't yet have the right points for, `SwitchControl.actuate`
    // only *requests* the switch and withholds clearance — the train does not
    // yet hold the onward edge. For a length-aware train the approach edge stays
    // held (its tail still occupies it), so the junction marker remains locked
    // under block exclusivity and no peer can grab a conflicting branch. A POINT
    // train (length_mm 0/undefined) releases its approach edge the instant its
    // head reaches the junction — opening a window where the junction is
    // unprotected, into which a peer can be granted, leading to switch
    // oscillation and deadlock. Switched-junction serialization therefore
    // currently requires length-aware trains; see the keystone test.
    let edgesReleased = false;
    if (!train.length_mm || train.length_mm === 0) {
      const before = train.cleared_edges.length;
      train.cleared_edges = train.cleared_edges.filter((e) => e.to_marker_id !== markerId);
      edgesReleased = train.cleared_edges.length !== before;
    }

    // Discovery: when a train moves from one marker to another, either
    // confirm an existing edge (inferred or not) or learn a new one.
    // The `in_discovery_mode` flag on marker_traversed reflects whether
    // the edge we just crossed is still inferred after this traversal.
    const out: SchedulerEffect[] = [];
    if (edgesReleased) {
      out.push(clearanceStateEffect(train));
    }
    const { effects: discoveryEffects, inDiscoveryMode } = this.recordTraversalAndDiscovery(
      previousMarker,
      markerId,
      trainId,
    );
    out.push(...discoveryEffects);

    /* `inferred_edge` is the directed edge the server concluded was just
     * completed (previous marker → this marker). Renderers use it to know
     * where a length-aware train's tail still extends (ADR-016); omitted on
     * the first traversal when there is no previous marker. */
    const completedEdge =
      previousMarker && previousMarker !== markerId
        ? { inferred_edge: { from_marker_id: previousMarker, to_marker_id: markerId } }
        : {};
    out.push(
      effects.publishEvent('marker_traversed', {
        train_id: trainId,
        marker_id: markerId,
        direction: 'forward',
        in_discovery_mode: inDiscoveryMode,
        ...completedEdge,
      }),
    );

    /* ADR-036: a vector is established by ANY two consecutive crossings, not only
     * the §3a introduce-roll. A not-yet-introduced train that has just completed a
     * VALID traversal (a real edge P→M — `previousMarker` defined and distinct, and
     * not a topology violation, both already guaranteed at this point) is now known
     * to be on P→M heading toward M, so AUTO-INTRODUCE it. This covers the toy-table
     * / discovery workflow where a train is driven by `begin_exploration` (which
     * discovers edges AND moves the train) before being scheduled. It fires exactly
     * once: the next crossing sees `introduced === true`. The 'discovered' source
     * neither stops the moving train nor seeds occupancy (see resolveIntroduction).
     * It returns its own clearance/scheduling effects, so we skip the normal
     * horizon top-up below when it fires. */
    if (!train.introduced && !train.introducing && previousMarker && previousMarker !== markerId) {
      out.push(
        ...this.resolveIntroduction(
          train,
          markerId,
          { from_marker_id: previousMarker, to_marker_id: markerId },
          'discovered',
        ),
      );
      return out;
    }

    // If we've just completed the current transit and replanned to the next
    // stop, the replan emits its own initial grant + horizon — skip the
    // top-up pass on the *old* transit.
    if (scheduleReplanEffects.length > 0) {
      out.push(...scheduleReplanEffects);
    } else {
      // Top up the clearance horizon on every crossing, unconditionally — not
      // only when the train reaches its limit marker. This is the headline of
      // the proactive-horizon model: the train always carries several blocks of
      // clearance ahead and so never decelerates to a stop at an intermediate
      // marker.
      out.push(...this.clearance.extendHorizon(train));
    }

    out.push(...this.retryBlockedClearances());

    return out;
  }

  /**
   * Is this train running a bounded route the scheduler issued (ADR-019
   * "expecting" mode)? True iff it has a planned transit — the discriminator
   * is per-train state the scheduler already holds, not a new flag. A train
   * exploring (ADR-015) or under track-learn (ADR-014) is driven by an
   * open-ended `begin_exploration` grant issued straight to the device and
   * never has a `transit`, so it is in OPEN mode (`false`) and an unexplained
   * adjacency is the discovery signal, not a violation. The coarse global
   * `--discovery` layout is the degenerate case: no routes assigned ⇒ every
   * train open ⇒ behaviour unchanged.
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
  private detectTopologyViolation(
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
  private handleTopologyViolation(
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
   * Advance the train's transit progress when it reports the to_marker of
   * the edge it's currently on. Idempotent: a marker that doesn't match the
   * current edge is a no-op.
   *
   * If the advance completes the transit AND the train has arrived at its
   * scheduled target stop, advance the schedule's stop pointer and replan
   * the next transit — emitting an `assign_route` command for the new
   * transit and an initial clearance grant. The returned effects flow
   * straight back to the caller in `handleTrainAtMarker`.
   */
  private advanceTransitAndReplanIfReached(
    train: TrainState,
    markerId: string,
  ): ReadonlyArray<SchedulerEffect> {
    if (!train.transit) return [];
    const currentEdge = train.transit.edges[train.transit.progress_index];
    if (!currentEdge || currentEdge.to_marker_id !== markerId) return [];

    const newIndex = train.transit.progress_index + 1;
    train.transit = { ...train.transit, progress_index: newIndex };
    /* Advance the heading to the next edge while the transit is in progress; but
     * when it COMPLETES (no next edge) KEEP the arrival edge as the heading. The
     * heading is what `planAndExecuteCurrentTransit` feeds the planner to forbid a
     * 180° U-turn — wiping it to `undefined` here let a schedule WRAP (last stop →
     * first stop) plan the reverse shortcut on a bidirectional loop, so the train
     * was handed a route it can't drive (no `grant_reverse`) and parked at the
     * last stop instead of looping. Keeping the arrival heading makes the wrap
     * continue FORWARD around the loop. */
    train.current_edge = train.transit.edges[newIndex] ?? currentEdge;

    // Transit still in progress — caller continues with maybeExtendClearance
    // against the same transit.
    if (newIndex < train.transit.edges.length) return [];

    // Transit complete. If we've landed on the scheduled stop, begin the
    // deterministic dwell rather than replanning immediately: hold the train
    // here (no pointer advance, no onward grant) until the dwell elapses. The
    // expiry is observed on a later `train_status` (the parked train keeps
    // emitting status), which triggers `advanceScheduleAndReplan`.
    if (train.schedule && train.schedule.stops[train.schedule.current_stop_index] === markerId) {
      train.dwell_until = this.now() + STATION_DWELL_MS;
      return [];
    }

    return [];
  }

  // ---------- switch state ----------

  private handleSwitchStateChanged(payload: unknown): ReadonlyArray<SchedulerEffect> {
    const result = this.switches.handleStateChanged(payload);
    if (!result.confirmed) return result.effects;
    return [...result.effects, ...this.retryBlockedClearances()];
  }

  // ---------- train_status → tail-clearance release ----------

  /**
   * Handle a `train_status` event from a length-aware train. For trains with
   * `length_mm > 0`, the head crossing a boundary marker is not sufficient to
   * release the section behind it — the tail must also have cleared. This
   * method walks backward through `cleared_edges` to find every held edge
   * whose cumulative distance from the head exceeds `length_mm`, and releases
   * all of them in one pass.
   *
   * The backward chain starts at B1 = current_edge.from_marker_id and follows
   * the to_marker links: depth-k edge is the unique cleared edge whose
   * to_marker_id equals the depth-(k-1) edge's from_marker_id. Cumulative
   * distance at depth k is estimated_distance_from_edge_start_mm plus the sum
   * of estimated_length_mm of the intervening edges at depths 1..k-1.
   *
   * Conservative hold: if an intermediate edge's estimated_length_mm is
   * undefined, the walk stops there and deeper edges remain held. This is
   * deliberate — the scheduler must never guess a length to release clearance
   * (safety asymmetry: holding too long is safe, releasing too early is not).
   *
   * Point trains (length_mm undefined or 0) release on `marker_traversed`
   * (handleTrainAtMarker) and are unaffected by this method.
   *
   * Ignored unless the sending device is the train it describes.
   */
  private handleTrainStatus(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { train_id, current_edge, estimated_distance_from_edge_start_mm } = payload as {
      train_id: string;
      current_edge?: { from_marker_id: string; to_marker_id: string } | undefined;
      estimated_distance_from_edge_start_mm?: number | undefined;
    };

    /* Only a train reports its own status: a status naming another train could
     * seed its heading or release its tail blocks. */
    if (deviceId !== train_id) return [];

    const train = this.trains.get(train_id);
    if (!train) return [];

    /* Trust the train's reported heading to SEED an initial direction. A train
     * is an autonomous agent: when it reports which edge its head is on, that
     * IS its facing. We adopt it only to fill a genuine gap — the train has no
     * heading yet (freshly registered / parked between legs) and is not in a
     * zone (where `zone_entry_edge` carries the arrival heading instead). This
     * is what stops a stopped train from being routed 180° off the way it
     * points: the planner now plans FROM its real facing. Once a route is
     * running, `current_edge` is non-undefined and this is a no-op. */
    if (
      current_edge !== undefined &&
      train.current_edge === undefined &&
      train.zone_entry_edge === undefined
    ) {
      train.current_edge = current_edge;
    }

    /* Deterministic station dwell. Checked before the length gate because the
     * dwell applies to point trains too. When the dwell has elapsed, clear it
     * and replan onward (advance the schedule pointer, plan the next leg, emit
     * the route + grant). The parked train keeps emitting `train_status`, so a
     * later status reliably observes the expiry. */
    if (train.dwell_until !== undefined && this.now() >= train.dwell_until) {
      train.dwell_until = undefined;
      return this.advanceScheduleAndReplan(train);
    }

    // Only apply tail-deferral logic to trains with a registered length.
    if (!train.length_mm || train.length_mm === 0) return [];

    // We need both the current edge and a distance reading.
    if (!current_edge || estimated_distance_from_edge_start_mm === undefined) return [];

    if (!this.clearance.releaseTail(train, current_edge, estimated_distance_from_edge_start_mm)) {
      return [];
    }
    return [clearanceStateEffect(train), ...this.retryBlockedClearances()];
  }

  /**
   * Retry clearance for every train whose current route edge isn't yet
   * cleared to it. Called after any state change that might unblock a
   * previously-denied edge (capability state change, switch position change,
   * a peer train freeing the block).
   *
   * `skipTrainIds` exists for `revokeClearance`: the revoked train must not
   * be eligible to immediately re-grab the block it was just told to release,
   * which would defeat the entire operator action.
   */
  private retryBlockedClearances(
    skipTrainIds?: ReadonlySet<string>,
  ): ReadonlyArray<SchedulerEffect> {
    const out: SchedulerEffect[] = [];
    /* Iterate in the explicit total order (ADR-017 §2), NOT Map-insertion
     * order. When several trains contend for one free section in this pass the
     * highest-ranked reaches the clearance grant first and takes it; ADR-011's
     * conflict check then denies the rest. The grant mechanism is unchanged —
     * only the order of consideration is now a named policy. */
    for (const train of this.trains.ordered()) {
      if (skipTrainIds?.has(train.train_id)) continue;
      // Re-run the full horizon walk per train, not just the single next edge:
      // an unblocked train should fill its whole look-ahead in one retry pass,
      // not creep forward one edge per unrelated event.
      out.push(...this.clearance.extendHorizon(train));
    }
    out.push(...this.resolveDeadlockOrEmitState(skipTrainIds));
    return out;
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
  private resolveDeadlockOrEmitState(
    skipTrainIds?: ReadonlySet<string>,
  ): ReadonlyArray<SchedulerEffect> {
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
       * reported unchanged, exactly as before. */
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
    out.push(...this.retryBlockedClearances(new Set([victim.train_id])));
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
         * sweeps into the track BEHIND X. For a point train (length 0) the body is
         * at X and nothing sweeps. For a length-aware train the body extends
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
   * A point train (`length_mm` 0/undefined) is trivially covered: nothing sweeps.
   *
   * Pure graph + occupancy query; no clock, no RNG. The visited-marker guard plus
   * the retained-edge-count bound guarantee termination on cyclic topologies.
   */
  private reverseBodyCoveredByHeldTail(
    victim: TrainState,
    targetMarkerId: string,
    retainedEdges: ReadonlyArray<EdgeRef>,
  ): boolean {
    const lengthMm = victim.length_mm ?? 0;
    if (lengthMm <= 0) return true; // point train: body is at X, nothing sweeps behind.

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
    out.push(...this.retryBlockedClearances(new Set([victim.train_id])));
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

  // ---------- generic capability dispatch ----------

  /**
   * Events not handled directly by the scheduler are dispatched to any
   * capability that wants to handle them. This is how `gate_state_changed`
   * reaches the gates_clearance capability without the scheduler needing
   * to know what gates are.
   */
  private dispatchToCapabilities(event: {
    event_type: string;
    device_id: string;
    payload: unknown;
  }): ReadonlyArray<SchedulerEffect> {
    const device = this.devices.get(event.device_id);
    if (!device) return [];
    return [...this.devices.dispatchEvent(device, event), ...this.retryBlockedClearances()];
  }

  // ---------- train introduction (ADR-036) ----------

  /**
   * Begin vector resolution for a registered-but-not-introduced train. The
   * operator calls this when they have placed a loco at a known-safe location.
   * This emits `introduce_train` to the train (authorising the bounded
   * introduction roll) and sets `introducing = true`. No-op when the train is
   * unknown or already introduced.
   *
   * Returns effects (empty on no-op). Mirrors the shape of `assignSchedule`.
   */
  introduceTrain(trainId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];
    if (train.introduced) return [];
    /* Already mid-roll: a second call must not restart the roll or re-send the
     * command (which would re-arm the device while it is already rolling). */
    if (train.introducing) return [];

    train.introducing = true;
    train.introduction_first_marker_id = undefined;

    return [effects.sendCommand(trainId, 'introduce_train', {})];
  }

  /**
   * ADR-036 §3c — operator/placer-provided vector introduction. When whatever
   * places a train already knows its facing (the simulator, a scene composer,
   * or an operator who set the loco down a known way), the placer supplies the
   * vector directly. No roll, no zone — the train is introduced immediately
   * with the given heading edge.
   *
   * `headingEdge.from_marker_id` is where the train sits; `to_marker_id` is
   * the direction it is committed to. Both markers must already exist in the
   * layout; the caller is responsible for that precondition (the server's
   * operator-command path checks this by virtue of passing an EdgeRef from a
   * validated protocol envelope).
   *
   * No-op (`[]`) if the train is unknown or already introduced — idempotent,
   * mirrors `introduceTrain`.
   */
  introduceTrainWithVector(trainId: string, headingEdge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];
    if (train.introduced) return [];
    return this.resolveIntroduction(train, headingEdge.from_marker_id, headingEdge, 'operator');
  }

  /**
   * Handle a marker crossed during the two-marker introduction roll (ADR-036
   * §3a). On the first crossing: record the marker. On the second DISTINCT
   * crossing: resolve the heading, end the roll, emit `train_introduced`, and
   * run resolution (schedule start / conflict check).
   *
   * Re-reading the same marker (the train hasn't moved) is ignored — we wait for
   * a genuinely distinct second marker.
   */
  private handleIntroductionRollMarker(
    train: TrainState,
    markerId: string,
  ): ReadonlyArray<SchedulerEffect> {
    if (!train.introduction_first_marker_id) {
      /* First crossing of the roll — anchor the origin marker. */
      train.introduction_first_marker_id = markerId;
      return [];
    }

    /* Re-read of the same marker: the train hasn't moved yet — ignore. */
    if (train.introduction_first_marker_id === markerId) return [];

    /* Second distinct crossing — heading resolved. */
    const headingEdge = {
      from_marker_id: train.introduction_first_marker_id,
      to_marker_id: markerId,
    };
    return this.resolveIntroduction(train, markerId, headingEdge, 'roll');
  }

  /**
   * Handle an inbound `train_introduced` event emitted by a
   * `core.provides_train_heading` zone before it releases the train (ADR-036
   * §3b). Honoured ONLY when the emitting device declared that capability — a
   * device without it cannot hijack a train's vector. If the named train exists
   * and is not yet introduced, resolve its vector from the event payload.
   *
   * Idempotent: if the train is already introduced, this is a no-op — so the
   * core's OWN roll-path emission echoing back onto the bus does nothing (and it
   * is harmless that the echo is dropped on the authority check too, since the
   * roll path set the train's state directly before publishing).
   */
  private handleTrainIntroducedEvent(
    deviceId: string,
    payload: unknown,
  ): ReadonlyArray<SchedulerEffect> {
    /* Producer-authority gate (mirrors `core.assigns_tags`/`core.reports_length`):
     * only a device that declared `core.provides_train_heading` may supply a
     * train's vector. */
    const device = this.devices.get(deviceId);
    if (!device?.capabilities.includes('core.provides_train_heading')) return [];

    const { train_id, marker_id, heading_edge } = payload as {
      train_id: string;
      marker_id: string;
      heading_edge: { from_marker_id: string; to_marker_id: string };
    };

    const train = this.trains.get(train_id);
    if (!train) return [];

    /* Idempotent: already introduced (e.g. our own emission echoing back). */
    if (train.introduced) return [];

    return this.resolveIntroduction(train, marker_id, heading_edge, 'zone');
  }

  /**
   * Shared resolution step for all introduction paths. Sets the train's position
   * and heading, marks it introduced, updates retained state, then applies the
   * ADR-036 §5 safety check before starting any pending schedule.
   *
   * `source` controls which wire effects are emitted and whether an idle train
   * seeds occupancy:
   *   'roll'       — sends `revoke_clearance` (ends the §3a roll) and publishes
   *                  `train_introduced`. An idle (no-schedule) train seeds its
   *                  resolved block as occupancy (it has STOPPED there).
   *   'zone'       — neither command nor event: the zone device owns the release
   *                  and its OWN `train_introduced` was the incoming trigger. An
   *                  idle train seeds its resolved block (it rests at the throat).
   *   'operator'   — publishes `train_introduced` but does NOT `revoke_clearance`
   *                  (the train was stationary, never granted a roll clearance).
   *                  An idle train seeds its resolved block.
   *   'discovered' — the vector was established by ordinary MOVING traversal
   *                  (exploration / learn driving), not a dedicated introduce
   *                  gesture. Publishes `train_introduced` but NEITHER stops the
   *                  train (it is moving on) NOR seeds occupancy: a moving train's
   *                  block protection comes from its clearance GRANTS, not a seed,
   *                  and seeding the behind-the-head edge would orphan exactly as
   *                  the earlier auto-start bug. §5 + pending-schedule start still apply.
   */
  private resolveIntroduction(
    train: TrainState,
    markerId: string,
    headingEdge: { from_marker_id: string; to_marker_id: string },
    source: 'roll' | 'zone' | 'operator' | 'discovered',
  ): ReadonlyArray<SchedulerEffect> {
    train.introducing = undefined;
    train.introduction_first_marker_id = undefined;

    /* ADR-036 §5 conflict check, BEFORE the vector is committed: is the train
     * resolving into a block an active peer occupies? See `findIntroductionConflict`. */
    const conflictingTrain = this.findIntroductionConflict(train, markerId, headingEdge);
    if (conflictingTrain !== undefined) {
      return this.refuseConflictingIntroduction(train, conflictingTrain, headingEdge, source);
    }

    /* Commit the resolved vector. Any block held from an earlier refused
     * introduction is stale: the train has a fresh, safe vector now. */
    train.current_edge = headingEdge;
    train.last_marker_id = markerId;
    train.introduced = true;
    train.cleared_edges = [];

    const out: SchedulerEffect[] = [];

    /* The roll path owns the release (ADR-036 §3a): end the roll by stopping the
     * train on the wire, AND publish the resolved vector as `train_introduced`.
     * The zone path needs neither — the zone device controls the train's motion
     * until it releases, and its OWN `train_introduced` was the incoming trigger
     * (re-emitting would duplicate it).
     * The operator and discovered paths publish `train_introduced` so bus
     * subscribers learn the resolved vector, but do NOT send `revoke_clearance`:
     * the operator path's train was stationary (never granted a roll clearance),
     * and the discovered path's train is MOVING (exploring / about to be
     * scheduled) — there is nothing to stop. */
    if (source === 'roll') {
      out.push(
        effects.sendCommand(train.train_id, 'revoke_clearance', {
          reason: 'introduction_complete',
          immediate: true,
        }),
      );
    }
    if (source !== 'zone') {
      out.push(
        effects.publishEvent('train_introduced', {
          train_id: train.train_id,
          marker_id: markerId,
          heading_edge: headingEdge,
        }),
      );
    }

    /* Update the retained device state to carry `introduced: true`. */
    out.push(this.deviceStateEffect(train.train_id));

    /* No co-occupation. What protects the resolved block from a peer differs by
     * whether a schedule is waiting and whether the train is STOPPED or MOVING:
     *
     *  - PENDING SCHEDULE → start it now. `planAndExecuteCurrentTransit` plans
     *    the leg and grants the first horizon, which establishes occupancy from
     *    the PLANNED edges and is released normally as the train drives. We must
     *    NOT seed `headingEdge` here: it is the block BEHIND the head (the train
     *    already crossed `headingEdge.to_marker_id` to resolve), so the point-train
     *    release rule — which drops a held edge only when the train re-crosses
     *    that edge's END marker — would never release it. Since this path does not
     *    wipe `cleared_edges` (unlike `assignSchedule`), a seeded `headingEdge`
     *    would orphan and permanently lock the introduction section. The planned
     *    grant alone is the correct, self-releasing occupancy.
     *
     *  - NO SCHEDULE, train STOPPED at the resolved point ('roll'/'zone'/'operator')
     *    → seed `headingEdge` as occupancy so a peer approaching is excluded under
     *    block exclusivity (ADR-011, Scenario 6). The train holds this block
     *    without onward motion clearance; it cannot orphan because `assignSchedule`
     *    wipes `cleared_edges` when a schedule eventually arrives.
     *
     *  - NO SCHEDULE, train MOVING ('discovered') → do NOT seed. The train is
     *    rolling on (exploring); its block protection comes from its clearance
     *    GRANTS, not a seed, and seeding the behind-the-head edge would orphan
     *    exactly as the auto-start bug. It simply continues; a later schedule
     *    routes it normally. */
    if (train.schedule) {
      out.push(...this.planAndExecuteCurrentTransit(train));
    } else if (source !== 'discovered') {
      train.clearance_limit_marker_id = headingEdge.to_marker_id;
      if (!train.cleared_edges.some((e) => edgesEqual(e, headingEdge))) {
        train.cleared_edges = [...train.cleared_edges, headingEdge];
      }
      out.push(clearanceStateEffect(train));
    }
    out.push(...this.retryBlockedClearances());
    return out;
  }

  /**
   * ADR-036 §5 refusal of an unsafe vector. The train resolved into a block a
   * peer occupies, so the resolution is not accepted: the train stays off the
   * map (not introduced, no position committed, so the operator can introduce
   * it again once a train has been moved) and its pending schedule does not
   * start. It is still physically on the track, so its resolved block is held
   * as occupancy: block exclusivity keeps every other train out of it even after
   * the peer drives away. A rolling or exploring train is told to stop; a zone
   * owns its own train's motion and a placed train is already stationary.
   */
  private refuseConflictingIntroduction(
    train: TrainState,
    conflictingTrain: TrainState,
    headingEdge: EdgeRef,
    source: 'roll' | 'zone' | 'operator' | 'discovered',
  ): ReadonlyArray<SchedulerEffect> {
    train.cleared_edges = [headingEdge];
    const out: SchedulerEffect[] = [];
    if (source === 'roll' || source === 'discovered') {
      out.push(
        effects.sendCommand(train.train_id, 'revoke_clearance', {
          reason: 'introduction_conflict',
          immediate: true,
        }),
      );
    }
    out.push(
      effects.publishEvent('train_introduction_conflict', {
        train_id: train.train_id,
        conflicting_train_id: conflictingTrain.train_id,
        block_edge: headingEdge,
        reason: 'resolved vector co-occupies a block held by another train',
      }),
      clearanceStateEffect(train),
    );
    return out;
  }

  /**
   * ADR-036 §5 conflict detector. The train sits at `markerId` having resolved
   * onto `headingEdge`. A peer's held edge makes that unsafe when it is:
   *
   *  - the SAME undirected section (either orientation): co-occupation or head-on;
   *  - running INTO `markerId`: the peer's clearance ends exactly where the
   *    introduced train is standing, so under ADR-011 block exclusivity the two
   *    sections share that boundary marker with the peer approaching it.
   *
   * A peer edge that LEAVES `markerId`, or touches the other end of the resolved
   * block, is the resolvable trailing case (ADR §5 Scenario 4): one train simply
   * follows the other and ordinary block exclusivity holds the one behind.
   *
   * Every peer counts, introduced or not: a train whose own introduction was
   * refused still holds its resolved block as occupancy.
   *
   * Returns the first conflicting peer, or `undefined` if none.
   */
  private findIntroductionConflict(
    train: TrainState,
    markerId: string,
    headingEdge: EdgeRef,
  ): TrainState | undefined {
    for (const other of this.trains.values()) {
      if (other.train_id === train.train_id) continue;
      for (const held of other.cleared_edges) {
        const sameSection =
          held.from_marker_id === headingEdge.from_marker_id &&
          held.to_marker_id === headingEdge.to_marker_id;
        const headOn =
          held.from_marker_id === headingEdge.to_marker_id &&
          held.to_marker_id === headingEdge.from_marker_id;
        const approachingTrain = held.to_marker_id === markerId;
        if (sameSection || headOn || approachingTrain) return other;
      }
    }
    return undefined;
  }

  private deviceStateEffect(deviceId: string): SchedulerEffect {
    return this.devices.stateEffect(deviceId, this.trains.get(deviceId));
  }

  // ---------- schedule assignment (driven by external API, not events) ----------

  /**
   * Assign a *schedule* — the operator-facing intent for a train. The
   * schedule is an ordered list of stops (marker IDs); the planner computes
   * the transit between consecutive stops on demand, and the scheduler emits
   * the per-leg `assign_route` command (carrying the computed transit) and
   * the initial clearance grant. See ADR-010.
   *
   * Cycle behaviour is implicit: after the last stop, the train heads back
   * to the first. There is no `cyclic` flag.
   *
   * Starting position: the train's `last_marker_id`, or — if the train has
   * never moved — `stops[0]` (the schedule's first stop is treated as the
   * spawn marker).
   *
   * Returns effects. Empty list on a no-op (unknown train, empty stops list,
   * train at the only stop of a single-stop schedule). Anomaly + no
   * execution effects on referential errors (unknown stops) or when the
   * planner can't reach the next stop from the current marker.
   */
  assignSchedule(
    trainId: string,
    routeId: string,
    stops: ReadonlyArray<string>,
  ): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];
    if (stops.length === 0) return [];

    const unknownStops = stops.filter((s) => !this.layout.hasMarker(s));
    if (unknownStops.length > 0) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Schedule ${routeId} for ${trainId} references unknown marker(s): ${unknownStops.join(', ')}`,
        }),
      ];
    }

    train.cleared_edges = [];
    train.transit = undefined;
    /* An explicit operator gesture (reassign) lifts any scheduler-owned hold:
     * the train is being given fresh intent, so a stale `unknown_topology` flag
     * must not ride the retained clearance state once it is cleared and moving
     * again (ADR-019). This is distinct from the train's own next traversal
     * report, which must NOT auto-clear the hold. The same gesture lifts an
     * operator revoke: a new schedule is the operator releasing the stop. */
    train.block_reason = undefined;
    train.operator_hold = undefined;

    /* ADR-036: a not-yet-introduced train has NO known position — its
     * `last_marker_id` must NOT be guessed from `stops[0]` (that is exactly the
     * position-guess the ADR forbids, and it would make the train's first real
     * crossing auto-introduce on a bogus heading). Store the schedule pending,
     * pointer at the first stop, leaving position unset. When the vector resolves
     * (roll / zone / operator / discovered) the planner picks the leg from the
     * train's REAL resolved marker, and the schedule auto-starts then. */
    if (!train.introduced) {
      train.schedule = { route_id: routeId, stops, current_stop_index: 0 };
      return [this.scheduleStateEffect(train)];
    }

    // Determine starting marker. The schedule's first stop is the
    // conventional spawn point for a train already on the map.
    const startMarker = train.last_marker_id ?? stops[0];
    if (startMarker === undefined) return [];
    train.last_marker_id = startMarker;

    // The schedule's pointer is "the stop we are heading to next."
    // Convention: if the train starts AT stops[0], the next target is
    // stops[1] (or wraps around for a single-stop schedule, handled below).
    const startsAtFirstStop = startMarker === stops[0];
    const initialStopIndex = startsAtFirstStop ? Math.min(1, stops.length - 1) : 0;
    train.schedule = {
      route_id: routeId,
      stops,
      current_stop_index: initialStopIndex,
    };

    return [this.scheduleStateEffect(train), ...this.planAndExecuteCurrentTransit(train)];
  }

  /**
   * Retained-state snapshot of the train's operator-facing schedule. The
   * payload mirrors `train.schedule`; subscribers (e.g. the visualiser's
   * schedule list) read which stops the train cycles through and which
   * stop it's currently heading to. Published from `assignSchedule` (when
   * the operator picks the stops) and `advanceScheduleAndReplan` (when
   * the train arrives at its current target and the pointer advances).
   */
  private scheduleStateEffect(train: TrainState): SchedulerEffect {
    if (!train.schedule) {
      return effects.updateState('schedule', train.train_id, { train_id: train.train_id });
    }
    return effects.updateState('schedule', train.train_id, {
      train_id: train.train_id,
      route_id: train.schedule.route_id,
      stops: train.schedule.stops,
      current_stop_index: train.schedule.current_stop_index,
    });
  }

  /**
   * Plan a transit from the train's current marker to
   * `schedule.stops[current_stop_index]`, install it on the train, and emit
   * the `assign_route` command + the initial clearance grant. Internal —
   * callers are `assignSchedule` (first leg) and `advanceScheduleAndReplan`
   * (every subsequent leg).
   */
  private planAndExecuteCurrentTransit(train: TrainState): ReadonlyArray<SchedulerEffect> {
    /* ADR-036: a not-yet-introduced train has no known vector — never plan it.
     * The schedule may already be stored (held pending); it starts the instant
     * the vector resolves via resolveIntroduction(). */
    if (!train.introduced) return [];
    if (!train.schedule || train.last_marker_id === undefined) return [];
    if (!this.devices.declares(train.train_id, 'core.accepts_route')) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Train ${train.train_id} cannot be sent route ${train.schedule.route_id} without core.accepts_route`,
        }),
      ];
    }
    const targetStop = train.schedule.stops[train.schedule.current_stop_index];
    if (targetStop === undefined) return [];

    if (train.last_marker_id === targetStop) {
      // Already at the target stop. If the schedule is multi-stop, advance
      // and replan to the next stop. If it's a single-stop schedule, park.
      if (train.schedule.stops.length === 1) {
        train.transit = undefined;
        train.clearance_limit_marker_id = train.last_marker_id;
        return [];
      }
      return this.advanceScheduleAndReplan(train);
    }

    // Keep the route directional: a train may not flip 180° to take a shortcut.
    // `current_edge` carries the heading mid-route; at a zone throat (edge
    // cleared) `zone_entry_edge` carries the arrival heading so the resume drives
    // the train onward, not back in.
    const heading = train.current_edge ?? train.zone_entry_edge;
    const transitEdges = planTransit(this.layout, train.last_marker_id, targetStop, heading);
    if (transitEdges === null) {
      // Structural unreachability. Surface and leave the train parked —
      // the operator must fix the layout or the schedule.
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Schedule ${train.schedule.route_id} for ${train.train_id}: no path from ${train.last_marker_id} to stop ${targetStop}`,
        }),
      ];
    }
    if (transitEdges.length === 0) {
      // planTransit only returns [] when from === to, which is the
      // already-at-target case handled above. Defensive.
      return [];
    }

    const refusal = this.zones.admissionRefusal(train, targetStop);
    if (refusal) return [refusal];

    train.transit = { edges: transitEdges, progress_index: 0 };
    const firstEdge = transitEdges[0];
    if (!firstEdge) return [];
    train.clearance_limit_marker_id = firstEdge.from_marker_id;

    const out: SchedulerEffect[] = [
      effects.sendCommand(train.train_id, 'assign_route', {
        route_id: train.schedule.route_id,
        edges: transitEdges,
      }),
    ];
    // Grant the whole initial horizon, not just the first edge, so a fresh
    // train pulls away with several blocks of clearance ahead of it.
    out.push(...this.clearance.extendHorizon(train));

    // Wiping cleared_edges in assignSchedule may have released blocks that
    // peer trains were waiting on. Retry so they don't sit blocked until an
    // unrelated event triggers retry elsewhere.
    out.push(...this.retryBlockedClearances());
    return out;
  }

  /**
   * Move the schedule's stop pointer to the next stop (mod stops.length)
   * and replan a transit toward it. Called when the train arrives at the
   * current target stop.
   */
  private advanceScheduleAndReplan(train: TrainState): ReadonlyArray<SchedulerEffect> {
    if (!train.schedule) return [];
    const nextIndex = (train.schedule.current_stop_index + 1) % train.schedule.stops.length;
    train.schedule = { ...train.schedule, current_stop_index: nextIndex };
    // Publish the updated schedule pointer so the visualiser's schedule
    // list highlights the new target stop.
    return [this.scheduleStateEffect(train), ...this.planAndExecuteCurrentTransit(train)];
  }

  /**
   * Revoke a train's clearance. The train is told to stop (the wire-level
   * `revoke_clearance` command), its cleared edges are released back to the
   * pool, and any peers waiting on those blocks are reconsidered in the same
   * call so the operator's intent — free this section, give it to someone
   * else — lands atomically.
   *
   * The clearance limit collapses to wherever the train actually is: the next
   * extension attempt has to start from there. If the train has never moved,
   * the existing limit (set by `assignSchedule`) is left in place.
   *
   * The stop sticks: `operator_hold` makes every later grant attempt refuse
   * this train until the operator assigns it a fresh schedule.
   *
   * No-op if the train isn't registered.
   */
  revokeClearance(trainId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];

    train.cleared_edges = [];
    train.operator_hold = true;
    if (train.last_marker_id !== undefined) {
      train.clearance_limit_marker_id = train.last_marker_id;
    }
    /* An explicit operator revoke clears any scheduler-owned hold reason so the
     * retained clearance state doesn't keep reporting `unknown_topology` on a
     * train whose clearance has been deliberately emptied (ADR-019). */
    train.block_reason = undefined;

    return [
      effects.sendCommand(trainId, 'revoke_clearance', {
        reason: 'admin',
        immediate: true,
      }),
      clearanceStateEffect(train),
      ...this.retryBlockedClearances(new Set([trainId])),
    ];
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
    if (!train.schedule) return this.retryBlockedClearances();
    return [...this.planAndExecuteCurrentTransit(train), ...this.retryBlockedClearances()];
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
