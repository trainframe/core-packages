import type { Capability } from '../capability.js';
import type { CapabilityRegistry } from '../registry.js';
import { type SchedulerEffect, effects, grantClearancePayload } from './effects.js';
import type { LayoutState } from './layout-state.js';
import { TagRegistry } from './tag-registry.js';
import { type TrainState, initialTrainState } from './train-state.js';
import { type EdgeRef, edgesEqual } from './types.js';

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

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly layout: LayoutState,
  ) {}

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
      case 'tag_observed':
        return this.handleTagObserved(event.device_id, event.payload);
      case 'clearance_request':
        return this.handleClearanceRequest(event.payload);
      case 'switch_state_changed':
        return this.handleSwitchStateChanged(event.payload);
      case 'tag_assignment':
        return this.handleTagAssignment(event.device_id, event.payload);
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

    // If this device claims to be a train, initialise train state.
    if (capabilities.includes('core.controls_motion')) {
      if (!this.trains.has(deviceId)) {
        this.trains.set(deviceId, initialTrainState(deviceId));
      }
    }

    return [effects.updateState('devices', deviceId, { capabilities })];
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
    const { tag_id, assigned_kind, target_id } = payload as {
      tag_id: string;
      assigned_kind: 'marker' | 'vehicle';
      target_id: string;
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

    this.tags.assign(tag_id, { kind: assigned_kind, target_id });
    return [effects.updateState('tags', tag_id, { assigned_kind, target_id })];
  }

  /**
   * Update train position and decide whether to extend clearance.
   * The most consequential method in the scheduler.
   */
  private handleTrainAtMarker(trainId: string, markerId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];

    train.last_marker_id = markerId;
    this.advanceRouteIfArrivedAt(train, markerId);

    const out: SchedulerEffect[] = [
      effects.publishEvent('marker_traversed', {
        train_id: trainId,
        marker_id: markerId,
        direction: 'forward',
        in_discovery_mode: false,
      }),
    ];

    const grant = this.maybeExtendClearance(train, markerId);
    if (grant) out.push(grant);

    return out;
  }

  /**
   * Advance the train's route progress when it reports the to_marker of the
   * edge it's currently expected to be on. Idempotent: a marker that doesn't
   * match the current edge is a no-op (it'll surface as an anomaly elsewhere
   * once topology violation handling lands).
   */
  private advanceRouteIfArrivedAt(train: TrainState, markerId: string): void {
    if (!train.route) return;
    const currentEdge = train.route.edges[train.route.progress_index];
    if (!currentEdge || currentEdge.to_marker_id !== markerId) return;

    const newIndex = train.route.progress_index + 1;
    train.route = { ...train.route, progress_index: newIndex };
    train.current_edge = train.route.edges[newIndex];
  }

  /**
   * If the train has just reached its clearance limit and the route has more
   * edges ahead, attempt to grant clearance for the next edge.
   */
  private maybeExtendClearance(train: TrainState, markerId: string): SchedulerEffect | null {
    if (train.clearance_limit_marker_id !== markerId || !train.route) return null;
    const nextEdge = train.route.edges[train.route.progress_index];
    if (!nextEdge) return null;
    return this.tryGrantClearance(train, nextEdge);
  }

  // ---------- clearance request handling ----------

  private handleClearanceRequest(payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { train_id, next_edge } = payload as { train_id: string; next_edge: EdgeRef };
    const train = this.trains.get(train_id);
    if (!train) return [];

    const grant = this.tryGrantClearance(train, next_edge);
    return grant ? [grant] : [];
  }

  /**
   * Decide whether to extend a train's clearance to include the given edge.
   * Consults all capabilities with `onClearanceConsultation` hooks. If any
   * deny, clearance is withheld. Otherwise it's granted.
   *
   * Block exclusivity: an edge already cleared to another train always denies.
   */
  private tryGrantClearance(train: TrainState, nextEdge: EdgeRef): SchedulerEffect | null {
    if (this.edgeIsClearedToAnotherTrain(train.train_id, nextEdge)) return null;
    if (this.edgeRequiresMismatchedSwitch(nextEdge)) return null;
    if (this.anyCapabilityDeniesClearance(train, nextEdge)) return null;
    return this.grantClearance(train, nextEdge);
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

  private edgeIsClearedToAnotherTrain(trainId: string, edge: EdgeRef): boolean {
    for (const [otherId, other] of this.trains) {
      if (otherId === trainId) continue;
      if (other.cleared_edges.some((e) => edgesEqual(e, edge))) return true;
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

  private grantClearance(train: TrainState, nextEdge: EdgeRef): SchedulerEffect {
    train.clearance_limit_marker_id = nextEdge.to_marker_id;
    train.cleared_edges = [...train.cleared_edges, nextEdge];
    return effects.sendCommand(
      train.train_id,
      'grant_clearance',
      grantClearancePayload(nextEdge.to_marker_id, [nextEdge]),
    );
  }

  // ---------- switch state ----------

  private handleSwitchStateChanged(payload: unknown): ReadonlyArray<SchedulerEffect> {
    const { junction_marker_id, position, confirmed } = payload as {
      junction_marker_id: string;
      position: string;
      confirmed: boolean;
    };
    const out: SchedulerEffect[] = [
      effects.updateState('switches', junction_marker_id, { position, confirmed }),
    ];
    if (confirmed) {
      this.layout.setSwitchPosition(junction_marker_id, position);
      out.push(...this.retryBlockedClearances());
    }
    return out;
  }

  /**
   * Retry clearance for every train waiting at its current limit. Called
   * after any state change that might unblock a previously-denied edge
   * (capability state change, switch position change).
   */
  private retryBlockedClearances(): ReadonlyArray<SchedulerEffect> {
    const out: SchedulerEffect[] = [];
    for (const train of this.trains.values()) {
      if (!train.route || !train.clearance_limit_marker_id) continue;
      const nextEdge = train.route.edges[train.route.progress_index];
      if (!nextEdge) continue;
      if (train.last_marker_id !== train.clearance_limit_marker_id) continue;
      const grant = this.tryGrantClearance(train, nextEdge);
      if (grant) out.push(grant);
    }
    return out;
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

  // ---------- route assignment (driven by external API, not events) ----------

  /**
   * Assign a route to a train. Called by the server's HTTP/MQTT API in
   * response to user requests. Returns effects: the route command for the
   * train, plus an initial clearance grant for the first edge.
   */
  assignRoute(
    trainId: string,
    routeId: string,
    edges: ReadonlyArray<EdgeRef>,
  ): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];
    if (edges.length === 0) return [];

    train.route = { route_id: routeId, edges, progress_index: 0 };
    train.cleared_edges = [];
    const firstEdge = edges[0];
    if (!firstEdge) return [];
    train.clearance_limit_marker_id = firstEdge.from_marker_id;

    const out: SchedulerEffect[] = [
      effects.sendCommand(trainId, 'assign_route', { route_id: routeId, edges }),
    ];

    const grant = this.tryGrantClearance(train, firstEdge);
    if (grant) out.push(grant);
    return out;
  }
}
