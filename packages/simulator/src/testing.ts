/**
 * Higher-level test harness around `Simulation`. The simulator spec (see
 * docs/spec/simulator-v0.1.md, "Testing harness API") describes a
 * `startTestEnvironment` helper that bundles a seeded fault profile, a
 * pre-populated tag registry, and a small set of action+observation helpers.
 * This module provides exactly that.
 *
 * The simulator package is virtual-hardware-only — scheduling lives in
 * `@trainframe/server`. This harness wires a real `Server` to a real
 * `InMemoryBrokerClient`, then bridges this `Simulation` onto the same
 * broker via `BrokerBridge`. Because the in-memory broker dispatches
 * synchronously, every effect of `assignSchedule` lands before `advance()`
 * returns — no real-time waits are needed.
 *
 * Tests observe events through the broker, not through `sim.events`: the
 * broker is the union of device-emitted events (republished by the bridge)
 * and server-derived events (`marker_traversed`, `anomaly` with
 * `device_id === 'server'`). Observing `sim.events` directly would miss
 * the server-side half.
 */
import type { Layout } from '@trainframe/protocol';
import { InMemoryBrokerClient, Server } from '@trainframe/server';
import { BrokerBridge } from './broker-bridge.js';
import {
  type CapturedEvent,
  Simulation,
  type SimulationEventListener,
  type SimulationOptions,
} from './simulation.js';
import type { VirtualTrainConfig } from './virtual-train.js';

export type FaultProfileName = 'pristine' | 'realistic' | 'hostile';

/**
 * Named bundles of virtual-train physics. The simulator spec lists three
 * canonical levels; tests pick one without spelling out every knob. Custom
 * combinations are still possible via the `faults` option (any Partial
 * overrides the profile).
 */
export const FAULT_PROFILES: Record<FaultProfileName, Partial<VirtualTrainConfig>> = {
  pristine: {
    miss_rate: 0,
    double_read_rate: 0,
    spurious_read_rate: 0,
    stopping_noise: 0,
    overshoot_rate: 0,
    detection_latency_ms: { mean: 0, stddev: 0 },
  },
  realistic: {
    miss_rate: 0.01,
    double_read_rate: 0.005,
    spurious_read_rate: 0,
    stopping_noise: 0.05,
    overshoot_rate: 0,
    detection_latency_ms: { mean: 20, stddev: 5 },
  },
  hostile: {
    miss_rate: 0.1,
    double_read_rate: 0.05,
    spurious_read_rate: 0.001,
    stopping_noise: 0.2,
    overshoot_rate: 0.05,
    detection_latency_ms: { mean: 30, stddev: 10 },
  },
};

export interface TestEnvironmentOptions {
  readonly layout: Layout;
  /** Seed for `SeededRandom`. Required for deterministic tests. */
  readonly seed?: number;
  /**
   * One of the named profiles, or a `Partial<VirtualTrainConfig>` to apply
   * to every spawned train. Default: `'realistic'`.
   */
  readonly faults?: FaultProfileName | Partial<VirtualTrainConfig>;
  /** Tick interval forwarded to the underlying `Simulation`. */
  readonly tick_ms?: number;
  /**
   * Tag-registry seeding. `'identity'` (default) publishes a
   * `tag_assignment` per marker via a synthetic garage so `tag_observed`
   * events resolve cleanly on the server. `'none'` leaves the registry empty
   * — tests register tags explicitly.
   */
  readonly tags?: 'identity' | 'none';
}

export interface SpawnTrainOptions {
  readonly startEdge?: { from_marker_id: string; to_marker_id: string };
  /** Per-train overrides on top of the active fault profile. */
  readonly config?: Partial<VirtualTrainConfig>;
}

export interface WaitForEventOptions {
  readonly event_type: string;
  /** Optional subset of payload fields the event must match. */
  readonly matching?: Record<string, unknown>;
  /**
   * Maximum virtual ms to advance the clock while waiting. The harness
   * advances the simulation in tick-sized chunks until the event is seen
   * or this budget is exhausted. Default 5000 (virtual) ms.
   */
  readonly timeoutMs?: number;
}

export interface TestEnvironment {
  readonly simulation: Simulation;
  readonly server: Server;
  readonly client: InMemoryBrokerClient;
  /** Every event observed on `railway/events/+/+`, in arrival order. */
  readonly events: ReadonlyArray<CapturedEvent>;
  spawnTrain(train_id: string, options?: SpawnTrainOptions): void;
  spawnGate(device_id: string): ReturnType<Simulation['spawnGate']>;
  assignSchedule(train_id: string, stops: ReadonlyArray<string>, route_id?: string): void;
  revokeClearance(train_id: string): void;
  advance(ms: number): void;
  waitForEvent(opts: WaitForEventOptions): CapturedEvent;
  onEvent(listener: SimulationEventListener): () => void;
  getEventsOfType(event_type: string): ReadonlyArray<CapturedEvent>;
  shutdown(): void;
}

const DEFAULT_FAULTS: FaultProfileName = 'realistic';

interface WireEnvelope {
  readonly device_id?: unknown;
  readonly payload?: unknown;
}

export function startTestEnvironment(opts: TestEnvironmentOptions): TestEnvironment {
  const trainConfig = resolveFaults(opts.faults);
  const tagsMode = opts.tags ?? 'identity';
  const tick_ms = opts.tick_ms ?? 50;

  const simOptions: SimulationOptions = {
    layout: opts.layout,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    tick_ms,
  };
  const sim = new Simulation(simOptions);

  // Capture every event that flows on the broker (device-republished and
  // server-derived). This is the single source of truth for assertions —
  // observing `sim.events` directly would miss everything `device_id ===
  // 'server'` (e.g. `marker_traversed`).
  const capturedEvents: CapturedEvent[] = [];
  const listeners = new Set<SimulationEventListener>();
  const client = new InMemoryBrokerClient();
  client.subscribe('railway/events/+/+', (message) => {
    const parsed = decodeEnvelope(message.payload);
    if (parsed === null) return;
    const parts = message.topic.split('/');
    const event_type = parts[2];
    const device_id_from_topic = parts[3];
    if (!event_type || !device_id_from_topic) return;
    const device_id =
      typeof parsed.device_id === 'string' ? parsed.device_id : device_id_from_topic;
    const captured: CapturedEvent = {
      at_ms: sim.clock.now(),
      event_type,
      device_id,
      payload: parsed.payload ?? parsed,
    };
    capturedEvents.push(captured);
    for (const listener of listeners) listener(captured);
  });

  let envelopeSeq = 0;
  const newId = (): string => {
    envelopeSeq += 1;
    return `sim-${envelopeSeq}`;
  };
  const bridge = new BrokerBridge(sim, client, { newId });
  bridge.start();
  // Wire the server's scheduler clock to the simulation's virtual clock so a
  // synchronous `env.advance(ms)` deterministically expires station dwell —
  // without this the scheduler would read wall-clock time and never release a
  // dwelling train inside a synchronous test.
  const server = new Server({ layout: opts.layout, client, newId, now: () => sim.clock.now() });
  server.start();

  // Seed identity tags AFTER the bridge and server are subscribed; otherwise
  // the synthetic-garage events would land in `sim.events` but never reach
  // the server's TagRegistry and `tag_observed` events would never resolve
  // to `marker_traversed`.
  if (tagsMode === 'identity') {
    sim.seedIdentityTags(opts.layout);
  }

  const matches = (e: CapturedEvent, opts: WaitForEventOptions): boolean => {
    if (e.event_type !== opts.event_type) return false;
    if (!opts.matching) return true;
    const payload = e.payload as Record<string, unknown> | undefined;
    if (!payload) return false;
    for (const [key, value] of Object.entries(opts.matching)) {
      if (payload[key] !== value) return false;
    }
    return true;
  };

  return {
    simulation: sim,
    server,
    client,
    events: capturedEvents,
    spawnTrain(train_id, options) {
      const config = { ...trainConfig, ...options?.config };
      sim.spawnTrain(train_id, {
        ...(options?.startEdge ? { startEdge: options.startEdge } : {}),
        config,
      });
    },
    spawnGate(device_id) {
      return sim.spawnGate(device_id);
    },
    assignSchedule(train_id, stops, route_id) {
      server.assignSchedule(train_id, route_id ?? `route-${train_id}-${sim.clock.now()}`, stops);
    },
    revokeClearance(train_id) {
      server.revokeClearance(train_id);
    },
    advance(ms) {
      sim.advance(ms);
    },
    waitForEvent(waitOpts) {
      const existing = capturedEvents.find((e) => matches(e, waitOpts));
      if (existing) return existing;
      const budget = waitOpts.timeoutMs ?? 5_000;
      let spent = 0;
      while (spent < budget) {
        sim.advance(tick_ms);
        spent += tick_ms;
        const seen = capturedEvents.find((e) => matches(e, waitOpts));
        if (seen) return seen;
      }
      throw new Error(
        `waitForEvent timed out after ${budget}ms (virtual): no ${waitOpts.event_type} matching ${JSON.stringify(waitOpts.matching ?? {})}`,
      );
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getEventsOfType(event_type) {
      return capturedEvents.filter((e) => e.event_type === event_type);
    },
    shutdown() {
      bridge.stop();
      server.stop();
    },
  };
}

function resolveFaults(faults: TestEnvironmentOptions['faults']): Partial<VirtualTrainConfig> {
  if (faults === undefined) return FAULT_PROFILES[DEFAULT_FAULTS];
  if (typeof faults === 'string') return FAULT_PROFILES[faults];
  return faults;
}

function decodeEnvelope(payload: Uint8Array): WireEnvelope | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  return raw as WireEnvelope;
}
