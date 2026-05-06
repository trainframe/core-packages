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

interface CapturedEvent {
  at_ms: number;
  event_type: string;
  device_id: string;
  payload: unknown;
}

export interface SimulationOptions {
  layout: Layout;
  seed?: number;
  /** Tick interval for trains in ms. Smaller = more accurate, slower. */
  tick_ms?: number;
  /** Optional extra capabilities for satellite testing. */
  extraCapabilities?: ReadonlyArray<import('@trainframe/core').Capability<unknown>>;
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
  readonly scheduler: Scheduler;
  readonly events: CapturedEvent[] = [];
  readonly commands: CapturedEvent[] = [];

  private readonly trains = new Map<string, VirtualTrain>();
  private readonly gates = new Map<string, VirtualGate>();
  private readonly tick_ms: number;
  private last_tick_ms = 0;

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
    this.scheduler = new Scheduler(this.registry, this.layout);
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
    const train = new VirtualTrain(train_id, config, this.layout, this.random, this.clock, (e) =>
      this.captureAndDispatch(e),
    );
    this.trains.set(train_id, train);
    if (options?.startEdge) {
      train.placeAt(options.startEdge);
    }
    // Register with the scheduler.
    this.captureAndDispatch({
      event_type: 'device_registered',
      device_id: train_id,
      payload: { capabilities: ['core.controls_motion', 'core.accepts_route'] },
    });
    return train;
  }

  spawnGate(device_id: string): VirtualGate {
    const gate = new VirtualGate(device_id, (e) => this.captureAndDispatch(e));
    this.gates.set(device_id, gate);
    gate.register();
    return gate;
  }

  /** Assign a route to a train. */
  assignRoute(
    train_id: string,
    edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
    route_id = `route-${train_id}-${this.clock.now()}`,
  ): void {
    const effects = this.scheduler.assignRoute(train_id, route_id, edges);
    this.dispatchEffects(effects);
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

  private captureAndDispatch(event: { event_type: string; device_id: string; payload: unknown }) {
    this.events.push({ at_ms: this.clock.now(), ...event });
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
        // Server-derived events (anomaly, marker_traversed). For tests, capture them.
        this.events.push({
          at_ms: this.clock.now(),
          event_type: effect.event_type,
          device_id: 'server',
          payload: effect.payload,
        });
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
