import { PROTOCOL_VERSION } from '@trainframe/protocol';
import type { Layout } from '@trainframe/protocol';
import {
  BrokerBridge,
  type CapturedEvent,
  Simulation,
  type VirtualTrainConfig,
} from '@trainframe/simulator';
import type { BrokerClient } from '../broker/client.js';

interface RouteEdge {
  from_marker_id: string;
  to_marker_id: string;
}

export type SimRunnerStatus = 'idle' | 'running' | 'paused';

export interface SimRunnerSnapshot {
  readonly status: SimRunnerStatus;
  readonly sim_time_ms: number;
  readonly events_published: number;
  readonly train_ids: ReadonlyArray<string>;
}

export type SimRunnerMode = 'embedded' | 'device-only';

export interface SimRunnerOptions {
  /** Layout the sim is built around. */
  readonly layout: Layout;
  /** Virtual-ms advanced per real-time tick when running. */
  readonly tick_ms: number;
  /** Source of UUIDs for outbound envelopes. Defaults to crypto.randomUUID. */
  readonly newId?: () => string;
  /**
   * `embedded` (default): the simulation runs its own scheduler in-browser
   * and publishes both device events and server-derived events to the broker.
   * Use when there's no other server on the bus.
   *
   * `device-only`: the simulation has no embedded scheduler; the bridge
   * forwards device events to the broker and routes inbound commands from
   * `railway/commands/<device_id>` back into the simulation. Use when a real
   * `@trainframe/server` is also on the bus.
   */
  readonly mode?: SimRunnerMode;
  /**
   * If set, the simulation publishes identity tag_assignment events for
   * every marker on startup (see `SimulationOptions.register_tags`). Trains
   * spawned afterwards emit `tag_observed` with the resolved tag IDs.
   * Default off; embedded-mode demos and tests typically want `'identity'`.
   */
  readonly register_tags?: 'identity';
}

type SnapshotListener = (snapshot: SimRunnerSnapshot) => void;

/**
 * Drives a `Simulation` instance and bridges its events onto an MQTT broker.
 *
 * The sim core stays transport-agnostic — `Simulation.onEvent` exposes a flat
 * stream of captured events; this class wraps each one in the wire envelope
 * (event_id, timestamp_device, protocol_version) and publishes it to the
 * appropriate `railway/events/<type>/<device>` topic.
 *
 * UI state is exposed through `snapshot()` / `onSnapshotChange`, so the React
 * layer can render counts and statuses without reaching into private fields.
 */
export class SimRunner {
  private simulation: Simulation | null = null;
  private bridge: BrokerBridge | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private unsubscribeFromSim: (() => void) | null = null;
  private events_published = 0;
  private train_ids: string[] = [];
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly newId: () => string;
  private readonly mode: SimRunnerMode;

  constructor(
    private readonly client: BrokerClient,
    private readonly options: SimRunnerOptions,
  ) {
    this.newId = options.newId ?? defaultNewId;
    this.mode = options.mode ?? 'embedded';
  }

  /** Initialise a fresh `Simulation`. Idempotent — does nothing if already started. */
  start(): void {
    if (this.simulation) return;
    this.simulation = new Simulation({
      layout: this.options.layout,
      tick_ms: this.options.tick_ms,
      disableScheduler: this.mode === 'device-only',
      ...(this.options.register_tags ? { register_tags: this.options.register_tags } : {}),
    });
    this.unsubscribeFromSim = this.simulation.onEvent((event) => this.handleEvent(event));
    if (this.mode === 'device-only') {
      this.bridge = new BrokerBridge(this.simulation, this.client, { newId: this.newId });
      this.bridge.start();
    }
    this.publishLayoutState();
    this.notify();
  }

  /**
   * Publish the active layout as a retained MQTT state message so the
   * visualiser (or any other subscriber) can reconstruct the world's shape
   * on first connection. Topic: `railway/state/layout/<layout_name>`. Public
   * so the host UI can call it as soon as the runner mounts — applying a
   * layout is an operator-visible action and should propagate before Start.
   */
  publishLayoutState(): void {
    const topic = `railway/state/layout/${this.options.layout.name}`;
    const payload = new TextEncoder().encode(JSON.stringify(this.options.layout));
    this.client.publish(topic, payload, { retain: true });
  }

  /** Begin auto-advancing the sim on a real-time interval. */
  resume(): void {
    if (!this.simulation || this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(() => {
      this.simulation?.advance(this.options.tick_ms);
      this.notify();
    }, this.options.tick_ms);
    this.notify();
  }

  /** Stop auto-advancing without tearing down the sim. */
  pause(): void {
    if (this.intervalHandle === null) return;
    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    this.notify();
  }

  /** Tear down the simulation, dropping all state. */
  stop(): void {
    this.pause();
    // Despawn each train through the Simulation BEFORE we drop our reference
    // to it. Despawn emits `device_disconnected` through the captured-event
    // sink, which we route to the broker — so subscribers like the visualiser
    // stop drawing trains that are no longer present.
    if (this.simulation) {
      for (const trainId of this.train_ids) {
        this.simulation.despawnTrain(trainId);
      }
    }
    this.bridge?.stop();
    this.bridge = null;
    this.unsubscribeFromSim?.();
    this.unsubscribeFromSim = null;
    this.simulation = null;
    this.events_published = 0;
    this.train_ids = [];
    this.notify();
  }

  /** Advance the sim by `ms` virtual milliseconds without auto-running. */
  step(ms: number): void {
    if (!this.simulation) return;
    this.simulation.advance(ms);
    this.notify();
  }

  spawnTrain(train_id: string, startEdge: RouteEdge, config?: Partial<VirtualTrainConfig>): void {
    if (!this.simulation || this.train_ids.includes(train_id)) return;
    this.simulation.spawnTrain(train_id, { startEdge, ...(config ? { config } : {}) });
    this.train_ids = [...this.train_ids, train_id];
    this.notify();
  }

  assignRoute(train_id: string, edges: ReadonlyArray<RouteEdge>): void {
    if (this.mode === 'device-only') {
      throw new Error(
        'SimRunner.assignRoute is unavailable in device-only mode. Issue the ' +
          'assign_route command from a server on the broker instead.',
      );
    }
    this.simulation?.assignRoute(train_id, edges);
  }

  snapshot(): SimRunnerSnapshot {
    return {
      status: this.computeStatus(),
      sim_time_ms: this.simulation?.clock.now() ?? 0,
      events_published: this.events_published,
      train_ids: [...this.train_ids],
    };
  }

  onSnapshotChange(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  private computeStatus(): SimRunnerStatus {
    if (this.simulation === null) return 'idle';
    return this.intervalHandle === null ? 'paused' : 'running';
  }

  private handleEvent(event: CapturedEvent): void {
    if (this.mode !== 'device-only') {
      this.publishEvent(event);
    }
    this.events_published += 1;
    this.notify();
  }

  private publishEvent(event: CapturedEvent): void {
    const envelope = {
      event_id: this.newId(),
      device_id: event.device_id,
      timestamp_device: new Date().toISOString(),
      event_type: event.event_type,
      protocol_version: PROTOCOL_VERSION,
      payload: event.payload,
    };
    const topic = `railway/events/${event.event_type}/${event.device_id}`;
    this.client.publish(topic, new TextEncoder().encode(JSON.stringify(envelope)));
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const listener of this.snapshotListeners) listener(snap);
  }
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
