import type { Capability } from '../capability.js';
import type { CapabilityRegistry } from '../registry.js';
import { type SchedulerEffect, effects, grantClearancePayload } from './effects.js';
import type { LayoutState } from './layout-state.js';
import { planTransit } from './planner.js';
import { TagRegistry } from './tag-registry.js';
import { type TrainState, initialTrainState } from './train-state.js';
import { type EdgeRef, edgesEqual } from './types.js';

/**
 * Deterministic dwell at a scheduled stop, in milliseconds. When a train
 * arrives at its scheduled stop the scheduler holds it (no onward clearance,
 * no pointer advance) until this much injected-clock time has elapsed, so
 * trains visibly pause at stations. A named constant, not a magic number.
 */
export const STATION_DWELL_MS = 2500;

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
 */
export const CLEARANCE_HORIZON_EDGES = 3;

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
 * Information about a connected device, tracked by the scheduler.
 */
interface DeviceRecord {
  device_id: string;
  capabilities: ReadonlyArray<string>;
  /** Per-capability state: capability_id -> opaque state value. */
  capability_state: Map<string, unknown>;
}

/**
 * The scheduler. Stateful, but the state is fully observable and all
 * mutations happen through `handleEvent`.
 */
export class Scheduler {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly trains = new Map<string, TrainState>();
  private readonly tags = new TagRegistry();
  /**
   * The set of trains currently part of a detected waits-for cycle (sorted,
   * for stable equality checks). Kept on the scheduler so we only publish a
   * `railway/state/deadlock/active` retained snapshot when the deadlock set
   * actually changes — not on every event.
   */
  private currentDeadlock: ReadonlyArray<string> = [];
  /**
   * Per-junction switch position we have most recently *requested* via a
   * `set_switch_position` command (junction marker id → requested position).
   * Used for actuation idempotency: `retryBlockedClearances` fires on many
   * events, so we must issue the command only when the required position
   * differs from what we've already asked for — never once per retry while
   * the switch is mid-move. Synced to reality on confirmed `switch_state_changed`.
   */
  private readonly requestedSwitchPositions = new Map<string, string>();
  private readonly now: () => number;

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly layout: LayoutState,
    options: SchedulerOptions,
  ) {
    this.now = options.now;
  }

  /** Read-only view of the tag registry, exposed for the visualiser/tests. */
  getTagRegistry(): TagRegistry {
    return this.tags;
  }

  // ---------- public observers (for testing and the visualiser) ----------

  getTrainState(trainId: string): TrainState | undefined {
    return this.trains.get(trainId);
  }

  getTrainIds(): ReadonlyArray<string> {
    return [...this.trains.keys()];
  }

  getDeviceCapabilityState(deviceId: string, capabilityId: string): unknown {
    return this.devices.get(deviceId)?.capability_state.get(capabilityId);
  }

  getLayout(): LayoutState {
    return this.layout;
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
        return this.handleTagObserved(event.device_id, event.payload);
      case 'clearance_request':
        return this.handleClearanceRequest(event.payload);
      case 'switch_state_changed':
        return this.handleSwitchStateChanged(event.payload);
      case 'tag_assignment':
        return this.handleTagAssignment(event.device_id, event.payload);
      case 'train_status':
        return this.handleTrainStatus(event.payload);
      default:
        return this.dispatchToCapabilities(event);
    }
  }

  // ---------- device registration ----------

  private handleDeviceRegistered(
    deviceId: string,
    payload: unknown,
  ): ReadonlyArray<SchedulerEffect> {
    const { capabilities } = payload as { capabilities: string[] };

    const unknownCaps = this.registry.validateDeviceCapabilities(capabilities);
    if (unknownCaps.length > 0) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Device ${deviceId} declared unknown capabilities: ${unknownCaps.join(', ')}`,
        }),
      ];
    }

    const capabilityState = new Map<string, unknown>();
    for (const capId of capabilities) {
      const cap = this.registry.get(capId);
      if (cap) {
        capabilityState.set(capId, cap.initialiseStateFor(deviceId));
      }
    }

    this.devices.set(deviceId, {
      device_id: deviceId,
      capabilities,
      capability_state: capabilityState,
    });

    if (capabilities.includes('core.controls_motion')) {
      this.initTrainState(deviceId, payload);
    }

    if (capabilities.includes('core.controls_switch')) {
      this.maybeRecordSwitchPairing(deviceId, payload);
    }

    const trainLengthMm = (payload as { train_length_mm?: number }).train_length_mm;
    const deviceState =
      typeof trainLengthMm === 'number' && trainLengthMm > 0
        ? { capabilities, train_length_mm: trainLengthMm }
        : { capabilities };
    return [effects.updateState('devices', deviceId, deviceState)];
  }

  /**
   * Initialise (or re-initialise) train state when a device declares
   * `core.controls_motion`. Captures optional physical length for
   * tail-clearance deferral.
   */
  private initTrainState(deviceId: string, payload: unknown): void {
    if (!this.trains.has(deviceId)) {
      this.trains.set(deviceId, initialTrainState(deviceId));
    }
    const trainLengthMm = (payload as { train_length_mm?: number }).train_length_mm;
    if (trainLengthMm !== undefined && trainLengthMm > 0) {
      const train = this.trains.get(deviceId);
      if (train) {
        train.length_mm = trainLengthMm;
      }
    }
  }

  /**
   * Record the junction marker → switch device pairing when a device declares
   * `core.controls_switch` with a `controls_marker_id` field. The field is
   * optional and non-breaking for devices that omit it.
   */
  private maybeRecordSwitchPairing(deviceId: string, payload: unknown): void {
    const controlsMarkerId = (payload as { controls_marker_id?: unknown }).controls_marker_id;
    if (typeof controlsMarkerId === 'string') {
      this.layout.recordSwitchPairing(deviceId, controlsMarkerId);
    }
  }

  // ---------- device disconnect ----------

  /**
   * A device vanished. Run every capability's `onDeviceDisconnect` hook so
   * capability-owned state (e.g. gates_clearance withholds) is released,
   * translate any intents the hooks produced, then drop the device record.
   * If the device declared `core.controls_motion`, drop its train state too
   * so the block it owned in `cleared_edges` no longer denies peers.
   *
   * Finally retry blocked clearances: peers waiting on a withhold the
   * vanished device held, or on an edge the vanished train was hogging,
   * should be granted now in the same handler call.
   */
  private handleDeviceDisconnect(deviceId: string): ReadonlyArray<SchedulerEffect> {
    const device = this.devices.get(deviceId);
    if (!device) return [];

    const out: SchedulerEffect[] = [];
    for (const capId of device.capabilities) {
      const cap = this.registry.get(capId);
      if (!cap) continue;
      const oldState = device.capability_state.get(capId);
      const result = cap.invokeOnDeviceDisconnect(oldState);
      device.capability_state.set(capId, result.newState);
      out.push(...this.translateIntents(result.intents, deviceId));
    }

    this.devices.delete(deviceId);
    if (device.capabilities.includes('core.controls_motion')) {
      // Emit empty clearance + schedule snapshots so the visualiser removes
      // the overlay and schedule-list entry for this train. Publish before
      // deleting the train record.
      out.push(
        effects.updateState('clearance', deviceId, {
          train_id: deviceId,
          cleared_edges: [],
        }),
        effects.updateState('schedule', deviceId, { train_id: deviceId }),
      );
      this.trains.delete(deviceId);
    }

    out.push(...this.retryBlockedClearances());
    return out;
  }

  // ---------- tag observed → marker traversed ----------

  private handleTagObserved(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { tag_id } = payload as { tag_id: string };

    const binding = this.tags.resolve(tag_id);
    if (!binding) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'info',
          description: `Unknown tag observed: ${tag_id} (not in the tag registry)`,
        }),
      ];
    }

    const device = this.devices.get(deviceId);
    if (!device) return [];

    // Trains reading their own readers traverse markers. Trackside detectors
    // reading vehicle tags identify vehicles. Each case derives a different
    // event from the same raw tag_observed.
    if (binding.kind === 'marker' && device.capabilities.includes('core.controls_motion')) {
      return this.handleTrainAtMarker(deviceId, binding.target_id);
    }

    if (binding.kind === 'vehicle') {
      return [
        effects.publishEvent('vehicle_identified', {
          vehicle_id: binding.target_id,
          context_device_id: deviceId,
        }),
      ];
    }

    // Marker tag read by a non-train device. The protocol's marker_traversed
    // event requires a train_id, so there's no derived event we can publish
    // here without a registered vehicle context.
    return [];
  }

  /**
   * Bind a tag to an entity. Only devices that declared `core.assigns_tags`
   * at registration may mutate the registry. Updates to the registry are
   * published as retained state so fresh subscribers see the world's tag
   * bindings.
   */
  private handleTagAssignment(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { tag_id, assigned_kind, target_id, marker_kind } = payload as {
      tag_id: string;
      assigned_kind: 'marker' | 'vehicle';
      target_id: string;
      marker_kind?: string;
    };

    const device = this.devices.get(deviceId);
    if (!device || !device.capabilities.includes('core.assigns_tags')) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Device ${deviceId} attempted tag_assignment without core.assigns_tags`,
        }),
      ];
    }

    const out: SchedulerEffect[] = [];

    // Discovery (ADR-009): a marker assignment can point at a target that
    // doesn't yet exist in the layout. Create the marker on the fly so the
    // scheduler can route through it as soon as the train sees it again.
    if (assigned_kind === 'marker' && !this.layout.hasMarker(target_id)) {
      const kind = isMarkerKind(marker_kind) ? marker_kind : 'unspecified';
      const added = this.layout.upsertMarker(target_id, kind);
      if (added) {
        out.push(effects.updateState('layout', this.layout.name, this.layout.toLayout()));
      }
    }

    this.tags.assign(tag_id, { kind: assigned_kind, target_id });
    out.push(effects.updateState('tags', tag_id, { assigned_kind, target_id }));
    return out;
  }

  /**
   * Update train position and decide whether to extend clearance.
   * The most consequential method in the scheduler.
   */
  private handleTrainAtMarker(trainId: string, markerId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];

    const previousMarker = train.last_marker_id;
    train.last_marker_id = markerId;
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
    // a junction it doesn't yet have the right points for, `maybeActuateSwitch`
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
    let inDiscoveryMode = false;
    const out: SchedulerEffect[] = [];
    if (edgesReleased) {
      out.push(this.clearanceStateEffect(train));
    }
    if (previousMarker && previousMarker !== markerId) {
      const result = this.layout.recordTraversal(previousMarker, markerId, trainId);
      const edge = this.layout.findEdge(previousMarker, markerId);
      inDiscoveryMode = edge?.inferred ?? false;
      if (result.inferredEdgeAdded || result.edgeConfirmed) {
        out.push(effects.updateState('layout', this.layout.name, this.layout.toLayout()));
      }
    }

    out.push(
      effects.publishEvent('marker_traversed', {
        train_id: trainId,
        marker_id: markerId,
        direction: 'forward',
        in_discovery_mode: inDiscoveryMode,
      }),
    );

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
      out.push(...this.extendClearanceHorizon(train));
    }

    out.push(...this.retryBlockedClearances());

    return out;
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
    train.current_edge = train.transit.edges[newIndex];

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

  /**
   * Grant clearance PROACTIVELY to a horizon of `CLEARANCE_HORIZON_EDGES` edges
   * ahead of the edge the train is currently on. Walks forward from
   * `transit.progress_index`, granting any edge not yet held, until either the
   * horizon is full or an edge can't be granted.
   *
   * Counting rule: edges already in `cleared_edges` count toward the horizon
   * (they're clearance the train still holds ahead of it) but are skipped, not
   * re-granted. We stop as soon as the count of cleared-ahead edges reaches the
   * horizon.
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
  private extendClearanceHorizon(train: TrainState): ReadonlyArray<SchedulerEffect> {
    if (!train.transit) return [];
    const out: SchedulerEffect[] = [];
    let granted = 0;
    for (
      let i = train.transit.progress_index;
      i < train.transit.edges.length && granted < CLEARANCE_HORIZON_EDGES;
      i++
    ) {
      const edge = train.transit.edges[i];
      if (!edge) break;
      if (train.cleared_edges.some((e) => edgesEqual(e, edge))) {
        // Already held — counts toward the horizon, no re-grant.
        granted++;
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
    }
    return out;
  }

  // ---------- clearance request handling ----------

  private handleClearanceRequest(payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { train_id, next_edge } = payload as { train_id: string; next_edge: EdgeRef };

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

    return this.tryGrantClearance(train, next_edge);
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
    // Conflict check FIRST (ADR-011 block exclusivity). This ordering is the
    // invariant that prevents two trains fighting over one switch: a train
    // only reaches the actuation branch once it has exclusive claim to the
    // junction's section, so it cannot flip the points out from under a peer
    // that already holds the junction.
    if (this.edgeConflictsWithAnotherTrain(train.train_id, nextEdge)) return [];
    if (this.edgeRequiresMismatchedSwitch(nextEdge)) return this.maybeActuateSwitch(nextEdge);
    if (this.anyCapabilityDeniesClearance(train, nextEdge)) return [];
    return this.grantClearance(train, nextEdge);
  }

  /**
   * The edge needs the junction in a position it isn't confirmed to be in.
   * If a switch device is paired to the junction, throw it — emit a single
   * `set_switch_position` command toward the edge's required position — and
   * still WITHHOLD clearance (return only the command, no grant). When the
   * switch confirms, `handleSwitchStateChanged` → `setSwitchPosition` →
   * `retryBlockedClearances` re-runs `tryGrantClearance`, the position now
   * matches, and clearance is granted.
   *
   * Idempotency: we send only when the required position differs from the one
   * we've already requested for this junction (`requestedSwitchPositions`).
   * `retryBlockedClearances` fires on many events; without this guard the
   * command would re-issue on every retry while the switch is mid-move.
   *
   * If no switch device is paired, withhold as before (empty list) — the
   * junction's position must be changed by some other agent (operator, learn
   * mode) before the train can proceed.
   */
  private maybeActuateSwitch(edge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    const layoutEdge = this.layout.findEdge(edge.from_marker_id, edge.to_marker_id);
    const required = layoutEdge?.requires_switch_state;
    if (!required) return [];

    const switchDeviceId = this.layout.switchDeviceForMarker(edge.from_marker_id);
    if (switchDeviceId === undefined) return [];

    if (this.requestedSwitchPositions.get(edge.from_marker_id) === required) return [];

    this.requestedSwitchPositions.set(edge.from_marker_id, required);
    return [
      effects.sendCommand(switchDeviceId, 'set_switch_position', {
        junction_marker_id: edge.from_marker_id,
        position: required,
      }),
    ];
  }

  /**
   * Edge filtering by switch state. If the edge declares a
   * `requires_switch_state`, the junction's current position must match.
   * Unknown position counts as a mismatch (default-safe).
   */
  private edgeRequiresMismatchedSwitch(edge: EdgeRef): boolean {
    const layoutEdge = this.layout.findEdge(edge.from_marker_id, edge.to_marker_id);
    const required = layoutEdge?.requires_switch_state;
    if (!required) return false;
    return this.layout.getSwitchPosition(edge.from_marker_id) !== required;
  }

  /**
   * Two sections conflict when they share either boundary marker. A train
   * holding `A→B` therefore locks markers A and B; any edge whose `from` or
   * `to` is A or B is denied to other trains. ADR-011.
   */
  private edgeConflictsWithAnotherTrain(trainId: string, edge: EdgeRef): boolean {
    for (const [otherId, other] of this.trains) {
      if (otherId === trainId) continue;
      for (const held of other.cleared_edges) {
        if (
          held.from_marker_id === edge.from_marker_id ||
          held.from_marker_id === edge.to_marker_id ||
          held.to_marker_id === edge.from_marker_id ||
          held.to_marker_id === edge.to_marker_id
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private anyCapabilityDeniesClearance(train: TrainState, nextEdge: EdgeRef): boolean {
    const request = {
      train_id: train.train_id,
      current_limit_marker_id: train.clearance_limit_marker_id ?? '',
      proposed_new_limit_marker_id: nextEdge.to_marker_id,
      proposed_edges_to_clear: [nextEdge],
    };
    for (const device of this.devices.values()) {
      for (const capId of device.capabilities) {
        const cap = this.registry.get(capId);
        if (!cap) continue;
        const state = device.capability_state.get(capId);
        const vote = cap.invokeOnClearanceConsultation(state, request);
        if (vote && vote.vote === 'deny') return true;
      }
    }
    return false;
  }

  private grantClearance(train: TrainState, nextEdge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    train.clearance_limit_marker_id = nextEdge.to_marker_id;
    train.cleared_edges = [...train.cleared_edges, nextEdge];
    return [
      effects.sendCommand(
        train.train_id,
        'grant_clearance',
        grantClearancePayload(nextEdge.to_marker_id, [nextEdge]),
      ),
      this.clearanceStateEffect(train),
    ];
  }

  /**
   * Emit a retained-state snapshot of which edges this train currently holds.
   * Published every time `cleared_edges` is mutated (grant, release, revoke,
   * disconnect). An empty array clears the visual — the visualiser drops the
   * train's overlay entries when it sees [].
   */
  private clearanceStateEffect(train: TrainState): SchedulerEffect {
    return effects.updateState('clearance', train.train_id, {
      train_id: train.train_id,
      cleared_edges: train.cleared_edges,
    });
  }

  // ---------- switch state ----------

  private handleSwitchStateChanged(payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { junction_marker_id, position, confirmed } = payload as {
      junction_marker_id: string;
      position: string;
      confirmed: boolean;
    };

    if (!this.layout.hasMarker(junction_marker_id)) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `switch_state_changed references unknown junction marker: ${junction_marker_id}`,
        }),
      ];
    }

    const out: SchedulerEffect[] = [
      effects.updateState('switches', junction_marker_id, { position, confirmed }),
    ];
    if (confirmed) {
      this.layout.setSwitchPosition(junction_marker_id, position);
      // Sync our requested-position view to reality. If the switch landed on a
      // position we didn't request, the next retry is free to re-actuate; if it
      // landed on the one we requested, this is a no-op that keeps the
      // idempotency guard accurate.
      this.requestedSwitchPositions.set(junction_marker_id, position);
      out.push(...this.retryBlockedClearances());
    }
    return out;
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
   */
  private handleTrainStatus(payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { train_id, current_edge, estimated_distance_from_edge_start_mm } = payload as {
      train_id: string;
      current_edge?: { from_marker_id: string; to_marker_id: string } | undefined;
      estimated_distance_from_edge_start_mm?: number | undefined;
    };

    const train = this.trains.get(train_id);
    if (!train) return [];

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

    const edgesToRelease = this.collectTailReleases(
      train,
      current_edge,
      estimated_distance_from_edge_start_mm,
    );
    if (edgesToRelease.length === 0) return [];

    train.cleared_edges = train.cleared_edges.filter(
      (e) => !edgesToRelease.some((r) => edgesEqual(r, e)),
    );
    return [this.clearanceStateEffect(train), ...this.retryBlockedClearances()];
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
    currentEdge: { from_marker_id: string; to_marker_id: string },
    distanceMm: number,
  ): ReadonlyArray<EdgeRef> {
    const lengthMm = train.length_mm ?? 0;
    const result: EdgeRef[] = [];
    const forwardEdgeKeys = this.buildForwardEdgeKeys(train, currentEdge);

    const visitedMarkers = new Set<string>();
    let boundaryMarker = currentEdge.from_marker_id;
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
    currentEdge: { from_marker_id: string; to_marker_id: string },
  ): ReadonlySet<string> {
    const keys = new Set<string>();
    keys.add(`${currentEdge.from_marker_id}->${currentEdge.to_marker_id}`);
    if (!train.transit) return keys;
    for (let i = train.transit.progress_index; i < train.transit.edges.length; i++) {
      const fe = train.transit.edges[i];
      if (fe) keys.add(`${fe.from_marker_id}->${fe.to_marker_id}`);
    }
    return keys;
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
    for (const train of this.trains.values()) {
      if (skipTrainIds?.has(train.train_id)) continue;
      // Re-run the full horizon walk per train, not just the single next edge:
      // an unblocked train should fill its whole look-ahead in one retry pass,
      // not creep forward one edge per unrelated event.
      out.push(...this.extendClearanceHorizon(train));
    }
    out.push(...this.maybeEmitDeadlockState());
    return out;
  }

  /**
   * Run a waits-for cycle detection over the trains that currently have a
   * next-edge they want but haven't been granted. A cycle means two or more
   * trains are mutually blocking each other under the section-pair rule
   * (ADR-011): T1 holds an edge that shares a marker with T2's wanted edge,
   * and T2 holds an edge sharing a marker with T1's wanted edge.
   *
   * We don't try to *resolve* the deadlock — the topology change that fixes
   * it (more markers, an actual passing siding) is an authoring decision.
   * We just surface the state so the operator sees it on the visualiser.
   *
   * Emits an `update_state_snapshot` on `railway/state/deadlock/active`
   * carrying the sorted list of train IDs in the cycle. When the deadlock
   * resolves (any train moves and the cycle disappears), publishes an empty
   * list so the banner clears. Only publishes when the set changes —
   * `retryBlockedClearances` is called from many event handlers and we don't
   * want to thrash the topic.
   */
  private maybeEmitDeadlockState(): ReadonlyArray<SchedulerEffect> {
    const cycle = this.detectWaitsForCycle();
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
      const blockers: string[] = [];
      for (const [otherId, other] of this.trains) {
        if (otherId === trainId) continue;
        if (anyEdgeSharesMarker(other.cleared_edges, wanted)) blockers.push(otherId);
      }
      graph.set(trainId, blockers);
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

    const out: SchedulerEffect[] = [];
    for (const capId of device.capabilities) {
      const cap = this.registry.get(capId);
      if (!cap) continue;

      const oldState = device.capability_state.get(capId);
      const result = cap.invokeOnEvent(oldState, {
        device_id: event.device_id,
        event_type: event.event_type,
        payload: event.payload,
        device_capabilities: device.capabilities,
      });

      device.capability_state.set(capId, result.newState);
      out.push(...this.translateIntents(result.intents, event.device_id));
    }

    out.push(...this.retryBlockedClearances());
    return out;
  }

  private translateIntents(
    intents: ReadonlyArray<import('../capability.js').SchedulerIntent>,
    sourceDeviceId: string,
  ): SchedulerEffect[] {
    const out: SchedulerEffect[] = [];
    for (const intent of intents) {
      switch (intent.kind) {
        case 'send_command':
          out.push(effects.sendCommand(intent.device_id, intent.command_type, intent.payload));
          break;
        case 'emit_anomaly':
          out.push(
            effects.publishEvent('anomaly', {
              severity: intent.severity,
              description: intent.description,
              context: { source_device_id: sourceDeviceId },
            }),
          );
          break;
        // withhold/release intents are state-only; the scheduler reads the
        // capability state directly during clearance consultation.
        case 'withhold_clearance_at_marker':
        case 'release_clearance_at_marker':
          break;
      }
    }
    return out;
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

    // Determine starting marker. The schedule's first stop is the
    // conventional spawn point for a fresh train.
    const startMarker = train.last_marker_id ?? stops[0];
    if (startMarker === undefined) return [];
    train.last_marker_id = startMarker;
    train.cleared_edges = [];
    train.transit = undefined;

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
    if (!train.schedule || train.last_marker_id === undefined) return [];
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

    const transitEdges = planTransit(this.layout, train.last_marker_id, targetStop);
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
    out.push(...this.extendClearanceHorizon(train));

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
   * No-op if the train isn't registered.
   */
  revokeClearance(trainId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];

    train.cleared_edges = [];
    if (train.last_marker_id !== undefined) {
      train.clearance_limit_marker_id = train.last_marker_id;
    }

    return [
      effects.sendCommand(trainId, 'revoke_clearance', {
        reason: 'admin',
        immediate: true,
      }),
      this.clearanceStateEffect(train),
      ...this.retryBlockedClearances(new Set([trainId])),
    ];
  }
}

const VALID_MARKER_KINDS = new Set([
  'block_boundary',
  'station_stop',
  'junction',
  'terminus',
  'yard_entry',
  'unspecified',
]);

type MarkerKind =
  | 'block_boundary'
  | 'station_stop'
  | 'junction'
  | 'terminus'
  | 'yard_entry'
  | 'unspecified';

function isMarkerKind(value: unknown): value is MarkerKind {
  return typeof value === 'string' && VALID_MARKER_KINDS.has(value);
}

function anyEdgeSharesMarker(held: ReadonlyArray<EdgeRef>, wanted: EdgeRef): boolean {
  for (const e of held) {
    if (
      e.from_marker_id === wanted.from_marker_id ||
      e.from_marker_id === wanted.to_marker_id ||
      e.to_marker_id === wanted.from_marker_id ||
      e.to_marker_id === wanted.to_marker_id
    ) {
      return true;
    }
  }
  return false;
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
