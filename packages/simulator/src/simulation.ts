import {
  BUILTIN_CAPABILITIES,
  CapabilityRegistry,
  LayoutState,
  Scheduler,
  type SchedulerEffect,
} from '@trainframe/core';
import type { Layout } from '@trainframe/protocol';
import { VirtualClock } from './clock.js';
import { SeededRandom } from './random.js';
import { VirtualGate } from './virtual-gate.js';
import { DEFAULT_TRAIN_CONFIG, VirtualTrain, type VirtualTrainConfig } from './virtual-train.js';

export interface CapturedEvent {
  at_ms: number;
  event_type: string;
  device_id: string;
  payload: unknown;
}

export type SimulationEventListener = (event: CapturedEvent) => void;

export interface CapturedStateSnapshot {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly state: unknown;
}

export type SimulationStateSnapshotListener = (snapshot: CapturedStateSnapshot) => void;

export interface SimulationOptions {
  layout: Layout;
  seed?: number;
  /** Tick interval for trains in ms. Smaller = more accurate, slower. */
  tick_ms?: number;
  /** Optional extra capabilities for satellite testing. */
  extraCapabilities?: ReadonlyArray<import('@trainframe/core').Capability<unknown>>;
  /**
   * Run without an embedded scheduler. Virtual devices still emit events
   * and accept commands, but routing/clearance decisions are expected to
   * come from an external server over a broker (see `BrokerBridge`).
   * Default: false (embedded scheduler runs as before).
   */
  disableScheduler?: boolean;
  /**
   * Test convenience: when set to `'identity'`, on construction the
   * simulation publishes a `device_registered` event for a synthetic
   * `SIM-GARAGE` declaring `core.assigns_tags`, then publishes one
   * `tag_assignment` event per marker binding `tag_id === marker_id` and
   * `target_id === marker_id`. Trains spawned afterwards inherit that
   * identity tag map so their `tag_observed` emissions resolve cleanly.
   *
   * Real layouts populate the registry via real garages; this option is a
   * conveniences wrapper around real events, not a back door into the
   * registry's private state. See ADR-007.
   */
  register_tags?: 'identity';
}

/**
 * In-process simulation: a scheduler, virtual devices, a virtual clock, and
 * the wiring between them. No broker, no MQTT — designed for fast, deterministic
 * tests.
 *
 * For live development with the visualiser, a separate "broker-backed"
 * simulator wraps this one and bridges events through MQTT. That's a thin
 * layer; the core logic lives here.
 */
export class Simulation {
  readonly clock = new VirtualClock();
  readonly random: SeededRandom;
  readonly registry: CapabilityRegistry;
  readonly layout: LayoutState;
  /** Embedded scheduler. Undefined when `disableScheduler` was set. */
  readonly scheduler: Scheduler | undefined;
  readonly events: CapturedEvent[] = [];
  readonly commands: CapturedEvent[] = [];

  private readonly eventListeners = new Set<SimulationEventListener>();
  private readonly stateSnapshotListeners = new Set<SimulationStateSnapshotListener>();
  private readonly trains = new Map<string, VirtualTrain>();
  private readonly gates = new Map<string, VirtualGate>();
  private readonly tick_ms: number;
  private last_tick_ms = 0;
  private readonly markerToTag: Map<string, string> = new Map();

  constructor(opts: SimulationOptions) {
    this.random = new SeededRandom(opts.seed ?? 42);
    this.tick_ms = opts.tick_ms ?? 50;

    this.registry = new CapabilityRegistry();
    this.registry.registerAll(BUILTIN_CAPABILITIES);
    if (opts.extraCapabilities) {
      this.registry.registerAll(opts.extraCapabilities);
    }
    this.registry.freeze();

    this.layout = new LayoutState(opts.layout);
    this.scheduler = opts.disableScheduler ? undefined : new Scheduler(this.registry, this.layout);

    if (opts.register_tags === 'identity') {
      this.seedIdentityTags(opts.layout);
    }
  }

  /**
   * Register a synthetic garage and publish one `tag_assignment` event per
   * marker, binding `tag_id === marker_id`. Uses the same event path as a
   * real garage device.
   */
  private seedIdentityTags(layout: Layout): void {
    this.captureAndDispatch({
      event_type: 'device_registered',
      device_id: 'SIM-GARAGE',
      payload: { capabilities: ['core.assigns_tags'] },
    });
    for (const marker of layout.markers) {
      this.markerToTag.set(marker.id, marker.id);
      this.captureAndDispatch({
        event_type: 'tag_assignment',
        device_id: 'SIM-GARAGE',
        payload: {
          tag_id: marker.id,
          assigned_kind: 'marker',
          target_id: marker.id,
        },
      });
    }
  }

  /** Register a virtual train. Returns the train so tests can inspect it. */
  spawnTrain(
    train_id: string,
    options?: {
      startEdge?: { from_marker_id: string; to_marker_id: string };
      config?: Partial<VirtualTrainConfig>;
    },
  ): VirtualTrain {
    const config = { ...DEFAULT_TRAIN_CONFIG, ...options?.config };
    const train = new VirtualTrain(
      train_id,
      config,
      this.layout,
      this.random,
      this.clock,
      (e) => this.captureAndDispatch(e),
      this.markerToTag,
    );
    this.trains.set(train_id, train);
    if (options?.startEdge) {
      train.placeAt(options.startEdge);
    }
    // Register with the scheduler. Include train_length_mm when non-zero so
    // the scheduler (and any broker listeners) can perform tail-release
    // calculations without assuming a point mass.
    const registrationPayload: {
      capabilities: string[];
      train_length_mm?: number;
    } = { capabilities: ['core.controls_motion', 'core.accepts_route'] };
    if (config.length_mm > 0) {
      registrationPayload.train_length_mm = config.length_mm;
    }
    this.captureAndDispatch({
      event_type: 'device_registered',
      device_id: train_id,
      payload: registrationPayload,
    });
    return train;
  }

  spawnGate(device_id: string): VirtualGate {
    const gate = new VirtualGate(device_id, (e) => this.captureAndDispatch(e));
    this.gates.set(device_id, gate);
    gate.register();
    return gate;
  }

  /**
   * Despawn a virtual train. Drops the train from the simulation and emits a
   * `device_disconnected` event so the scheduler (or any broker-side server)
   * runs capability disconnect hooks and releases any block the train was
   * still holding. Models a train being unplugged, derailed, or otherwise
   * vanishing from the network without a graceful handoff.
   */
  despawnTrain(train_id: string): void {
    if (!this.trains.has(train_id)) return;
    this.trains.delete(train_id);
    this.captureAndDispatch({
      event_type: 'device_disconnected',
      device_id: train_id,
      payload: {},
    });
  }

  /**
   * Despawn a virtual gate. Drops the gate from the simulation and emits a
   * `device_disconnected` event so the scheduler runs the gates_clearance
   * disconnect hook and releases all the gate's withholds. Models a gating
   * device losing power while it had a train held.
   */
  despawnGate(device_id: string): void {
    if (!this.gates.has(device_id)) return;
    this.gates.delete(device_id);
    this.captureAndDispatch({
      event_type: 'device_disconnected',
      device_id,
      payload: {},
    });
  }

  /**
   * Assign a *schedule* — an ordered list of stops the train cycles
   * through indefinitely — to an in-sim train. The scheduler invokes the
   * planner to compute the transit between stops on demand. See ADR-010.
   * Requires the embedded scheduler.
   */
  assignSchedule(
    train_id: string,
    stops: ReadonlyArray<string>,
    route_id = `route-${train_id}-${this.clock.now()}`,
  ): void {
    if (!this.scheduler) {
      throw new Error(
        'Simulation.assignSchedule called with the embedded scheduler disabled. ' +
          'Issue commands via the broker (railway/commands/{device_id}) instead.',
      );
    }
    const effects = this.scheduler.assignSchedule(train_id, route_id, stops);
    this.dispatchEffects(effects);
  }

  /**
   * Revoke a train's clearance. Mirrors `Server.revokeClearance` for the
   * in-process simulator: the scheduler decides what to send, this method
   * dispatches it. Used by operator-side "break the deadlock" / "make this
   * train stop" actions. Requires the embedded scheduler.
   */
  revokeClearance(train_id: string): void {
    if (!this.scheduler) {
      throw new Error(
        'Simulation.revokeClearance called with the embedded scheduler disabled. ' +
          'Issue commands via the broker (railway/commands/{device_id}) instead.',
      );
    }
    const effects = this.scheduler.revokeClearance(train_id);
    this.dispatchEffects(effects);
  }

  /**
   * Apply an external command to a virtual device. Used by the broker bridge
   * (device-only mode) so a real server can drive the simulation through the
   * wire instead of via the embedded scheduler.
   */
  handleCommand(device_id: string, command_type: string, payload: unknown): void {
    this.commands.push({ at_ms: this.clock.now(), event_type: command_type, device_id, payload });
    const train = this.trains.get(device_id);
    train?.acceptCommand(command_type, payload);
    const gate = this.gates.get(device_id);
    gate?.acceptCommand(command_type, payload);
  }

  /**
   * Advance the simulation by ms. Trains tick at the configured tick rate;
   * scheduled clock callbacks (like detection latency) fire interleaved.
   */
  advance(ms: number): void {
    const target_ms = this.clock.now() + ms;
    while (this.clock.now() < target_ms) {
      const next_tick = this.last_tick_ms + this.tick_ms;
      const next_event_at = Math.min(next_tick, target_ms);
      const dt = next_event_at - this.clock.now();
      if (dt > 0) this.clock.advance(dt);
      if (this.clock.now() >= next_tick) {
        this.tickAllTrains(this.tick_ms);
        this.last_tick_ms = this.clock.now();
      }
    }
  }

  private tickAllTrains(dt_ms: number): void {
    for (const train of this.trains.values()) {
      train.tick(dt_ms);
    }
  }

  /**
   * Subscribe to every captured event — both device-emitted events that the
   * simulation routes into the scheduler and server-derived publish_event
   * effects. Returns an unsubscribe function. This is how external transports
   * (e.g. an MQTT bridge) observe the sim without reaching into private fields.
   */
  onEvent(listener: SimulationEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Subscribe to `update_state_snapshot` effects emitted by the embedded
   * scheduler. The sim-runner uses this to publish retained MQTT state messages
   * (e.g. clearance state) on behalf of the embedded scheduler — mirroring
   * what `@trainframe/server`'s `dispatchEffects` does in server mode.
   */
  onStateSnapshot(listener: SimulationStateSnapshotListener): () => void {
    this.stateSnapshotListeners.add(listener);
    return () => {
      this.stateSnapshotListeners.delete(listener);
    };
  }

  private captureEvent(event: CapturedEvent): void {
    this.events.push(event);
    for (const listener of this.eventListeners) listener(event);
  }

  private captureAndDispatch(event: { event_type: string; device_id: string; payload: unknown }) {
    this.captureEvent({ at_ms: this.clock.now(), ...event });
    if (!this.scheduler) return;
    const effects = this.scheduler.handleEvent(event);
    this.dispatchEffects(effects);
  }

  private dispatchEffects(effects: ReadonlyArray<SchedulerEffect>): void {
    for (const effect of effects) {
      if (effect.kind === 'send_command') {
        this.commands.push({
          at_ms: this.clock.now(),
          event_type: effect.command_type,
          device_id: effect.device_id,
          payload: effect.payload,
        });
        const train = this.trains.get(effect.device_id);
        train?.acceptCommand(effect.command_type, effect.payload);
      } else if (effect.kind === 'publish_event') {
        // Server-derived events (anomaly, marker_traversed). Captured and
        // surfaced to listeners alongside device-emitted events.
        this.captureEvent({
          at_ms: this.clock.now(),
          event_type: effect.event_type,
          device_id: 'server',
          payload: effect.payload,
        });
      } else if (effect.kind === 'update_state_snapshot') {
        // State updates (clearance, layout, tags). Forwarded to snapshot
        // listeners so external transports (sim-runner in embedded mode) can
        // publish them as retained MQTT state messages.
        for (const listener of this.stateSnapshotListeners) {
          listener({
            entity_type: effect.entity_type,
            entity_id: effect.entity_id,
            state: effect.state,
          });
        }
      }
    }
  }

  /** Test helpers ------------------------------------------------------- */

  getTrain(id: string): VirtualTrain | undefined {
    return this.trains.get(id);
  }

  getCommandsForDevice(device_id: string): ReadonlyArray<CapturedEvent> {
    return this.commands.filter((c) => c.device_id === device_id);
  }

  getEventsOfType(event_type: string): ReadonlyArray<CapturedEvent> {
    return this.events.filter((e) => e.event_type === event_type);
  }
}
