import type { CapabilityRegistry } from '../registry.js';
import { ClearanceControl } from './clearance.js';
import { DeadlockResolver } from './deadlock.js';
import { DeviceTable, readRegistration } from './devices.js';
import { type SchedulerEffect, clearanceStateEffect, effects } from './effects.js';
import { IdentityAndTags } from './identity.js';
import { TrainIntroduction } from './introduction.js';
import type { LayoutState } from './layout-state.js';
import { ScheduleRunner } from './schedules.js';
import type { ClearanceRetry, MarkerOwnership } from './seams.js';
import { SwitchControl } from './switches.js';
import type { TagRegistry } from './tag-registry.js';
import { TopologyGuard } from './topology.js';
import { TrainRoster } from './train-roster.js';
import type { TrainState } from './train-state.js';
import { type EdgeRef, edgesEqual } from './types.js';
import { ZoneAuthority } from './zones.js';

export { STATION_DWELL_MS } from './schedules.js';
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
 * mutations happen through `handleEvent` and the operator actions below.
 *
 * It routes each event to the feature module that owns it and runs the marker
 * crossing pipeline that composes them. Each module owns its own state; the
 * train roster and device table are the shared views they read, and the
 * interfaces in `seams.ts` are the only ways one module calls back into
 * another.
 */
export class Scheduler {
  private readonly devices: DeviceTable;
  private readonly switches: SwitchControl;
  private readonly trains = new TrainRoster();
  private readonly identity: IdentityAndTags;
  private readonly zones: ZoneAuthority;
  private readonly clearance: ClearanceControl;
  private readonly deadlock: DeadlockResolver;
  private readonly introduction: TrainIntroduction;
  private readonly topology: TopologyGuard;
  private readonly schedules: ScheduleRunner;

  constructor(
    registry: CapabilityRegistry,
    private readonly layout: LayoutState,
    options: SchedulerOptions,
  ) {
    const now = options.now;
    this.devices = new DeviceTable(registry);
    const ownership: MarkerOwnership = {
      zoneOwnerOf: (markerId) => this.zones.ownerOf(markerId),
      switchOwnerOf: (markerId) => layout.switchDeviceForMarker(markerId),
    };
    this.switches = new SwitchControl(layout, ownership, now);
    const retry: ClearanceRetry = {
      retryBlockedClearances: (skip) => this.retryBlockedClearances(skip),
    };
    this.clearance = new ClearanceControl(layout, this.trains, this.switches, this.devices);
    this.zones = new ZoneAuthority(this.devices, this.trains, ownership, retry, {
      advanceScheduleAndReplan: (train) => this.schedules.advanceScheduleAndReplan(train),
    });
    this.schedules = new ScheduleRunner(
      layout,
      this.trains,
      this.devices,
      this.zones,
      this.clearance,
      retry,
      now,
    );
    this.deadlock = new DeadlockResolver(layout, this.trains, retry);
    this.introduction = new TrainIntroduction(this.devices, this.trains, retry, this.schedules);
    this.topology = new TopologyGuard(layout, this.trains, now, retry, this.schedules);
    this.identity = new IdentityAndTags(this.devices, this.trains, layout, {
      handleTrainCrossing: (trainId, markerId) => this.handleTrainCrossing(trainId, markerId),
    });
  }

  /** Read-only view of the tag registry, exposed for the visualiser/tests. */
  getTagRegistry(): TagRegistry {
    return this.identity.getTagRegistry();
  }

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
    this.deadlock.reset();
    this.switches.reset();
    this.zones.reset();
    this.layout.reset();
  }

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
        return this.introduction.handleTrainIntroducedEvent(event.device_id, event.payload);
      default:
        return this.dispatchToCapabilities(event);
    }
  }

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

  /**
   * Record the zone's boundary marker so the scheduler can recognise it (for
   * entry suspension and the reverse-admission gate), then dispatch to the
   * `core.gates_zone` capability, whose hook decides admission.
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
   * ADR-009) and report whether the crossed edge is still inferred.
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
      return this.introduction.handleRollMarker(train, markerId);
    }

    /* A not-yet-introduced train that is NOT on an introduction roll still has
     * its crossing OBSERVED here (topology validation, edge learning via
     * `recordTraversal`, the `marker_traversed` emission, exploration
     * continuation). This is required for learn-mode / discovery (ADR-014/015),
     * where an exploring train is deliberately not-introduced yet must teach the
     * graph as it rolls. ADR-036 gates ROUTING and CLEARANCE, not OBSERVATION:
     * such a train has no `transit` (planning is gated on `introduced`), so
     * `ScheduleRunner.advanceTransit` is a no-op, and the clearance horizon
     * early-returns for a not-introduced train, so nothing here routes it or
     * grants it clearance. */

    const previousMarker = train.last_marker_id;

    /* ADR-019 position validation, BEFORE we advance `last_marker_id`, release
     * any block, or call `recordTraversal` (all of which trust the report).
     * P = previousMarker (last certain position), M = markerId.
     *   1. P undefined            → first report, nothing to validate; anchor M.
     *   2. M == P                 → re-read of the current marker; fall through
     *                               (advanceTransit is a no-op, no traversal).
     *   3. edge P→M exists        → normal traversal.
     *   4. edge P→M absent, OPEN  → discovery: recordTraversal learns it (ADR-009).
     *   5. edge P→M absent, EXPECTING (bounded route+clearance) → topology
     *      violation: do NOT learn, hold, flag. Early return — `last_marker_id`
     *      is deliberately left at P (the last position we can vouch for). */
    const violation = this.topology.detectViolation(train, previousMarker, markerId);
    if (violation) {
      return this.topology.hold(train, violation.lastKnownMarkerId, markerId);
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
    const scheduleReplanEffects = this.schedules.advanceTransit(train, markerId);

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
     * neither stops the moving train nor seeds occupancy (see
     * `TrainIntroduction.resolve`). It returns its own clearance/scheduling
     * effects, so we skip the normal horizon top-up below when it fires. */
    if (!train.introduced && !train.introducing && previousMarker && previousMarker !== markerId) {
      out.push(
        ...this.introduction.resolve(
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

  private handleSwitchStateChanged(payload: unknown): ReadonlyArray<SchedulerEffect> {
    const result = this.switches.handleStateChanged(payload);
    if (!result.confirmed) return result.effects;
    return [...result.effects, ...this.retryBlockedClearances()];
  }

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
    const afterDwell = this.schedules.resumeIfDwellElapsed(train);
    if (afterDwell) return afterDwell;

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
     * conflict check then denies the rest. */
    for (const train of this.trains.ordered()) {
      if (skipTrainIds?.has(train.train_id)) continue;
      // Re-run the full horizon walk per train, not just the single next edge:
      // an unblocked train should fill its whole look-ahead in one retry pass,
      // not creep forward one edge per unrelated event.
      out.push(...this.clearance.extendHorizon(train));
    }
    out.push(...this.deadlock.resolveOrEmitState(skipTrainIds));
    return out;
  }

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

  /**
   * Begin the two-marker introduction roll (ADR-036 §3a) for a train the
   * operator has placed at a known-safe location. Empty when the train is
   * unknown, already introduced or already rolling.
   */
  introduceTrain(trainId: string): ReadonlyArray<SchedulerEffect> {
    return this.introduction.introduceTrain(trainId);
  }

  /**
   * Introduce a train whose placer already knows its facing (ADR-036 §3c):
   * it sits at `headingEdge.from_marker_id` committed toward `to_marker_id`.
   * Empty when the train is unknown or already introduced.
   */
  introduceTrainWithVector(trainId: string, headingEdge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    return this.introduction.introduceTrainWithVector(trainId, headingEdge);
  }

  /**
   * Give a train a schedule: the ordered stops it cycles through (ADR-010).
   * The first leg is planned and routed now if the train is on the map, or
   * when it is introduced if not. Empty for an unknown train or no stops; an
   * anomaly for unknown stops or an unreachable first stop.
   */
  assignSchedule(
    trainId: string,
    routeId: string,
    stops: ReadonlyArray<string>,
  ): ReadonlyArray<SchedulerEffect> {
    return this.schedules.assignSchedule(trainId, routeId, stops);
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
   * Re-anchor a train held for `unknown_topology` at a marker the operator
   * confirms (ADR-019 recovery). Empty if the train is not so held or the
   * marker is unknown.
   */
  reanchor(trainId: string, confirmedMarkerId: string): ReadonlyArray<SchedulerEffect> {
    return this.topology.reanchor(trainId, confirmedMarkerId);
  }

  /**
   * Accept the adjacency a held train reported as real, undiscovered track
   * and re-anchor it there (ADR-019 recovery). Empty if the train is not held
   * for `unknown_topology`.
   */
  confirmNewTrack(trainId: string): ReadonlyArray<SchedulerEffect> {
    return this.topology.confirmNewTrack(trainId);
  }
}
