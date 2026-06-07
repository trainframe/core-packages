import {
  BUILTIN_CAPABILITIES,
  type Capability,
  CapabilityRegistry,
  LayoutState,
} from '@trainframe/core';
import type { Layout } from '@trainframe/protocol';
import { VirtualClock } from './clock.js';
import { SeededRandom } from './random.js';
import { VirtualGate } from './virtual-gate.js';
import { VirtualSwitch } from './virtual-switch.js';
import { DEFAULT_TRAIN_CONFIG, VirtualTrain, type VirtualTrainConfig } from './virtual-train.js';

export interface CapturedEvent {
  at_ms: number;
  event_type: string;
  device_id: string;
  payload: unknown;
}

export type SimulationEventListener = (event: CapturedEvent) => void;

export interface SimulationOptions {
  layout: Layout;
  seed?: number;
  /** Tick interval for trains in ms. Smaller = more accurate, slower. */
  tick_ms?: number;
  /** Optional extra capabilities for satellite testing. */
  extraCapabilities?: ReadonlyArray<Capability<unknown>>;
}

/**
 * Virtual-hardware-only simulation. A bag of virtual devices (trains, gates)
 * driven by a deterministic clock and seeded RNG; they emit events through
 * `onEvent` and accept commands through `handleCommand`. Nothing routes,
 * grants clearance, or computes deadlocks here — that's the scheduler's job
 * and the scheduler lives in `@trainframe/server`.
 *
 * Tests that exercise scheduling stand up a real `Server` against an
 * `InMemoryBrokerClient`, then wire this `Simulation` to the same broker via
 * `BrokerBridge`. See `testing.ts` for the canonical harness.
 */
export class Simulation {
  readonly clock = new VirtualClock();
  readonly random: SeededRandom;
  readonly registry: CapabilityRegistry;
  readonly layout: LayoutState;
  readonly events: CapturedEvent[] = [];
  readonly commands: CapturedEvent[] = [];

  private readonly eventListeners = new Set<SimulationEventListener>();
  private readonly trains = new Map<string, VirtualTrain>();
  private readonly gates = new Map<string, VirtualGate>();
  private readonly switches = new Map<string, VirtualSwitch>();
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

    this.layout = new LayoutState(opts.layout, { now: () => this.clock.now() });
  }

  /**
   * Register a synthetic garage and publish one `tag_assignment` event per
   * marker, binding `tag_id === marker_id`. Uses the same event path as a
   * real garage device.
   *
   * Public so callers can invoke this AFTER subscribers (e.g. a
   * `BrokerBridge`) have attached; otherwise the events are appended to
   * `sim.events` but never reach the wire. See ADR-007.
   */
  seedIdentityTags(layout: Layout): void {
    this.captureEvent({
      at_ms: this.clock.now(),
      event_type: 'device_registered',
      device_id: 'GARAGE',
      payload: { capabilities: ['core.assigns_tags'] },
    });
    for (const marker of layout.markers) {
      this.markerToTag.set(marker.id, marker.id);
      this.captureEvent({
        at_ms: this.clock.now(),
        event_type: 'tag_assignment',
        device_id: 'GARAGE',
        payload: {
          tag_id: marker.id,
          assigned_kind: 'marker',
          target_id: marker.id,
        },
      });
    }
  }

  /**
   * Register a single identity binding `tag_id === marker_id` without
   * publishing any events. For callers that already published the
   * `tag_assignment` through some other path (e.g. the toy-table's
   * `ScanBox` flow) and only need the in-process `markerToTag` map
   * populated so virtual trains emit `tag_observed` for that marker.
   * Idempotent.
   */
  bindIdentityTag(markerId: string): void {
    this.markerToTag.set(markerId, markerId);
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
      (e) => this.captureEvent({ at_ms: this.clock.now(), ...e }),
      this.markerToTag,
    );
    this.trains.set(train_id, train);
    if (options?.startEdge) {
      train.placeAt(options.startEdge);
    }
    // Announce the train on the wire. Include train_length_mm when non-zero so
    // server-side capability hooks can perform tail-release calculations
    // without assuming a point mass.
    const registrationPayload: {
      capabilities: string[];
      train_length_mm?: number;
    } = { capabilities: ['core.controls_motion', 'core.accepts_route'] };
    if (config.length_mm > 0) {
      registrationPayload.train_length_mm = config.length_mm;
    }
    this.captureEvent({
      at_ms: this.clock.now(),
      event_type: 'device_registered',
      device_id: train_id,
      payload: registrationPayload,
    });
    // A real train powering up on top of a marker would read whatever tag is
    // under it and emit a tag_observed. Mirror that so the system learns where
    // the train sits at startup without waiting for it to move.
    if (options?.startEdge) {
      const startMarkerId = options.startEdge.from_marker_id;
      const tagId = this.markerToTag.get(startMarkerId);
      if (tagId !== undefined) {
        this.captureEvent({
          at_ms: this.clock.now(),
          event_type: 'tag_observed',
          device_id: train_id,
          payload: { tag_id: tagId, direction: 'forward' },
        });
      }
    }
    return train;
  }

  /**
   * Toggle a train's power WITHOUT despawning it. A powered-off train stays
   * in `this.trains` (so `getTrain` still returns it for the renderer to place
   * at its frozen position), becomes inert (stops moving, ignores commands),
   * and goes silent — crucially it emits NO `device_disconnected`. A server on
   * the bus therefore keeps its last state and holds its block reserved.
   * Power-on resumes driving from exactly where it stopped. No-op for an
   * unknown train id.
   *
   * This is distinct from `despawnTrain` (genuine removal, emits
   * `device_disconnected`) — power is not lifecycle.
   */
  setTrainPowered(train_id: string, powered: boolean): void {
    this.trains.get(train_id)?.setPowered(powered);
  }

  spawnGate(device_id: string): VirtualGate {
    const gate = new VirtualGate(device_id, (e) =>
      this.captureEvent({ at_ms: this.clock.now(), ...e }),
    );
    this.gates.set(device_id, gate);
    gate.register();
    return gate;
  }

  /**
   * Despawn a virtual train. Drops the train from the simulation and emits a
   * `device_disconnected` event so a server on the bus runs capability
   * disconnect hooks and releases any block the train was still holding.
   * Models a train being unplugged, derailed, or otherwise vanishing from
   * the network without a graceful handoff.
   */
  despawnTrain(train_id: string): void {
    if (!this.trains.has(train_id)) return;
    this.trains.delete(train_id);
    this.captureEvent({
      at_ms: this.clock.now(),
      event_type: 'device_disconnected',
      device_id: train_id,
      payload: {},
    });
  }

  /**
   * Despawn a virtual gate. Drops the gate from the simulation and emits a
   * `device_disconnected` event so a server on the bus runs the
   * gates_clearance disconnect hook and releases all the gate's withholds.
   * Models a gating device losing power while it had a train held.
   */
  despawnGate(device_id: string): void {
    if (!this.gates.has(device_id)) return;
    this.gates.delete(device_id);
    this.captureEvent({
      at_ms: this.clock.now(),
      event_type: 'device_disconnected',
      device_id,
      payload: {},
    });
  }

  /**
   * Register a virtual switch motor paired with `junction_marker_id`.
   * In the toy-table flow `device_id` is `SWITCH-{piece.id}` and
   * `junction_marker_id` is `M-{piece.id}`. The motor emits `device_registered`
   * with `controls_marker_id: junction_marker_id` so the server records the
   * pairing and LearnMode can address `set_switch_position` to the device,
   * not to the marker id.
   */
  spawnSwitch(device_id: string, junction_marker_id: string): VirtualSwitch {
    const sw = new VirtualSwitch(device_id, junction_marker_id, (e) =>
      this.captureEvent({ at_ms: this.clock.now(), ...e }),
    );
    this.switches.set(device_id, sw);
    sw.register();
    return sw;
  }

  /**
   * Despawn a virtual switch motor. Emits `device_disconnected` so the server
   * observes the motor going offline.
   */
  despawnSwitch(device_id: string): void {
    if (!this.switches.has(device_id)) return;
    this.switches.delete(device_id);
    this.captureEvent({
      at_ms: this.clock.now(),
      event_type: 'device_disconnected',
      device_id,
      payload: {},
    });
  }

  /**
   * Apply an external command to a virtual device. Used by the broker bridge
   * so a real server drives the simulation through the wire.
   */
  handleCommand(device_id: string, command_type: string, payload: unknown): void {
    this.commands.push({ at_ms: this.clock.now(), event_type: command_type, device_id, payload });
    const train = this.trains.get(device_id);
    train?.acceptCommand(command_type, payload);
    const gate = this.gates.get(device_id);
    gate?.acceptCommand(command_type, payload);
    const sw = this.switches.get(device_id);
    sw?.acceptCommand(command_type, payload);
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
   * Subscribe to every captured device-emitted event. Returns an unsubscribe
   * function. This is how external transports (e.g. an MQTT bridge) observe
   * the sim without reaching into private fields.
   */
  onEvent(listener: SimulationEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private captureEvent(event: CapturedEvent): void {
    this.events.push(event);
    for (const listener of this.eventListeners) listener(event);
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
