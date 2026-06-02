/**
 * Higher-level test harness around `Simulation`. The simulator spec (see
 * docs/spec/simulator-v0.1.md, "Testing harness API") describes a
 * `startTestEnvironment` helper that bundles a seeded fault profile, a
 * pre-populated tag registry, and a small set of action+observation helpers.
 * This module provides exactly that.
 *
 * In-process only today: Simulation runs its own scheduler, no broker is
 * spawned. The integration package's `startHarness` covers the broker-backed
 * variant; if a future test needs both shapes, this harness can grow a
 * `withBroker` option that wires up `BrokerBridge`.
 */
import type { Layout } from '@trainframe/protocol';
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
   * events resolve cleanly. `'none'` leaves the registry empty — tests
   * register tags explicitly.
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
  spawnTrain(train_id: string, options?: SpawnTrainOptions): void;
  spawnGate(device_id: string): ReturnType<Simulation['spawnGate']>;
  assignSchedule(train_id: string, stops: ReadonlyArray<string>, route_id?: string): void;
  advance(ms: number): void;
  waitForEvent(opts: WaitForEventOptions): CapturedEvent;
  onEvent(listener: SimulationEventListener): () => void;
  getEventsOfType(event_type: string): ReadonlyArray<CapturedEvent>;
  shutdown(): void;
}

const DEFAULT_FAULTS: FaultProfileName = 'realistic';

export function startTestEnvironment(opts: TestEnvironmentOptions): TestEnvironment {
  const trainConfig = resolveFaults(opts.faults);
  const tags = opts.tags ?? 'identity';
  const tick_ms = opts.tick_ms ?? 50;

  const simOptions: SimulationOptions = {
    layout: opts.layout,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    tick_ms,
    ...(tags === 'identity' ? { register_tags: 'identity' as const } : {}),
  };
  const sim = new Simulation(simOptions);

  return {
    simulation: sim,
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
      sim.assignSchedule(train_id, stops, route_id);
    },
    advance(ms) {
      sim.advance(ms);
    },
    waitForEvent(waitOpts) {
      return waitForEvent(sim, tick_ms, waitOpts);
    },
    onEvent(listener) {
      return sim.onEvent(listener);
    },
    getEventsOfType(event_type) {
      return sim.getEventsOfType(event_type);
    },
    shutdown() {
      // Symmetric API even though in-process Simulation has nothing to free.
      // Reserved for the future broker-backed variant.
    },
  };
}

function resolveFaults(faults: TestEnvironmentOptions['faults']): Partial<VirtualTrainConfig> {
  if (faults === undefined) return FAULT_PROFILES[DEFAULT_FAULTS];
  if (typeof faults === 'string') return FAULT_PROFILES[faults];
  return faults;
}

function waitForEvent(sim: Simulation, tick_ms: number, opts: WaitForEventOptions): CapturedEvent {
  const matches = (e: CapturedEvent): boolean => {
    if (e.event_type !== opts.event_type) return false;
    if (!opts.matching) return true;
    const payload = e.payload as Record<string, unknown> | undefined;
    if (!payload) return false;
    for (const [key, value] of Object.entries(opts.matching)) {
      if (payload[key] !== value) return false;
    }
    return true;
  };

  const existing = sim.events.find(matches);
  if (existing) return existing;

  const budget = opts.timeoutMs ?? 5_000;
  let spent = 0;
  while (spent < budget) {
    sim.advance(tick_ms);
    spent += tick_ms;
    const seen = sim.events.find(matches);
    if (seen) return seen;
  }
  throw new Error(
    `waitForEvent timed out after ${budget}ms (virtual): no ${opts.event_type} matching ${JSON.stringify(opts.matching ?? {})}`,
  );
}
