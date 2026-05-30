import {
  BUILTIN_CAPABILITIES,
  type Capability,
  CapabilityRegistry,
  LayoutState,
  Scheduler,
  type SchedulerEffect,
} from '@trainframe/core';
import { type Layout, PROTOCOL_VERSION } from '@trainframe/protocol';
import type { BrokerClient } from './broker/client.js';

interface RouteEdge {
  from_marker_id: string;
  to_marker_id: string;
}

export interface ServerOptions {
  /** Layout the server reasons against. Published as retained state on start. */
  readonly layout: Layout;
  /** Broker client. Inject `InMemoryBrokerClient` in unit tests, `MqttBrokerClient` in production. */
  readonly client: BrokerClient;
  /** Optional satellite capabilities to register alongside the built-ins. */
  readonly extraCapabilities?: ReadonlyArray<Capability<unknown>>;
  /** UUID source for outbound envelopes. Defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
}

interface IncomingEnvelope {
  readonly device_id?: unknown;
  readonly payload?: unknown;
}

/**
 * The server: a broker-connected scheduler. Subscribes to `railway/events/+/+`
 * (core events; custom events at six segments are passed through unchanged by
 * the broker but the server doesn't dispatch them yet — that's a follow-up).
 *
 * For each event:
 *   1. Parse the wire envelope (loose — malformed JSON is dropped, not thrown).
 *   2. Extract `(event_type, device_id, payload)`.
 *   3. Drop self-emitted events (`device_id === 'server'`) to avoid loops.
 *   4. Hand to `Scheduler.handleEvent`.
 *   5. Translate each `SchedulerEffect` back onto the broker:
 *      - `send_command`  → `railway/commands/{device_id}` (with envelope)
 *      - `publish_event` → `railway/events/{event_type}/server` (with envelope)
 *      - `update_state`  → `railway/state/{entity_type}/{entity_id}` retained
 */
export class Server {
  private readonly registry: CapabilityRegistry;
  private readonly layoutState: LayoutState;
  private readonly scheduler: Scheduler;
  private readonly newId: () => string;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: ServerOptions) {
    this.registry = new CapabilityRegistry();
    this.registry.registerAll(BUILTIN_CAPABILITIES);
    if (options.extraCapabilities) this.registry.registerAll(options.extraCapabilities);
    this.registry.freeze();
    this.layoutState = new LayoutState(options.layout);
    this.scheduler = new Scheduler(this.registry, this.layoutState);
    this.newId = options.newId ?? defaultNewId;
  }

  /** Begin processing wire events. Publishes the current layout retained. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.client.subscribe('railway/events/+/+', (msg) => {
      this.handleMessage(msg.topic, msg.payload);
    });
    this.publishLayoutState();
  }

  /** Detach from the broker without disconnecting the underlying client. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Assign a route to a train. Direct entry point used by tests and the
   * admin HTTP API; the wire-equivalent is a `tag_observed` round-trip
   * triggering route assignment - but route assignment itself is operator
   * intent, not device telemetry, so it has no wire event.
   */
  assignRoute(trainId: string, routeId: string, edges: ReadonlyArray<RouteEdge>): void {
    const effects = this.scheduler.assignRoute(trainId, routeId, edges);
    this.dispatchEffects(effects);
  }

  /**
   * Revoke a train's clearance. Mirrors `assignRoute`: the scheduler decides,
   * the server enacts. Returned effects include the `revoke_clearance` command
   * to the train and any `grant_clearance` commands to peers that were waiting
   * on the freed block. No-op if the train doesn't exist.
   */
  revokeClearance(trainId: string): void {
    const effects = this.scheduler.revokeClearance(trainId);
    this.dispatchEffects(effects);
  }

  /**
   * Inject an event into the scheduler exactly as if it had arrived on the
   * wire, then dispatch any effects. Used by the admin HTTP API for things
   * like operator-driven `tag_assignment`. Internal: prefer publishing on
   * MQTT from clients that can.
   */
  injectEvent(event_type: string, device_id: string, payload: unknown): void {
    const effects = this.scheduler.handleEvent({ event_type, device_id, payload });
    this.dispatchEffects(effects);
  }

  /**
   * Publish a command on `railway/commands/<device_id>`. Used by the admin
   * HTTP API to forward operator overrides (`hold_gate`, `release_gate`,
   * `revoke_clearance`) onto the wire so devices receive them through the
   * same path as scheduler-issued commands.
   */
  publishCommand(device_id: string, command_type: string, payload: unknown): void {
    this.options.client.publish(
      `railway/commands/${device_id}`,
      this.encodeCommand(command_type, device_id, payload),
    );
  }

  /** Test/observability hook. */
  getScheduler(): Scheduler {
    return this.scheduler;
  }

  /** Test/observability hook. */
  getLayoutState(): LayoutState {
    return this.layoutState;
  }

  // ----------------- internals -----------------

  private handleMessage(topic: string, payload: Uint8Array): void {
    const parts = topic.split('/');
    if (parts.length !== 4) return;
    const event_type = parts[2];
    const device_id_from_topic = parts[3];
    if (!event_type || !device_id_from_topic) return;

    const envelope = parseJsonEnvelope(payload);
    if (envelope === null) return;

    const device_id =
      typeof envelope.device_id === 'string' ? envelope.device_id : device_id_from_topic;
    // Skip events the server itself emitted to avoid feedback loops.
    if (device_id === 'server') return;

    const event_payload = envelope.payload ?? envelope;
    const effects = this.scheduler.handleEvent({
      event_type,
      device_id,
      payload: event_payload,
    });
    this.dispatchEffects(effects);
  }

  private dispatchEffects(effects: ReadonlyArray<SchedulerEffect>): void {
    for (const effect of effects) {
      if (effect.kind === 'send_command') {
        this.options.client.publish(
          `railway/commands/${effect.device_id}`,
          this.encodeCommand(effect.command_type, effect.device_id, effect.payload),
        );
      } else if (effect.kind === 'publish_event') {
        this.options.client.publish(
          `railway/events/${effect.event_type}/server`,
          this.encodeEvent(effect.event_type, 'server', effect.payload),
        );
      } else if (effect.kind === 'update_state_snapshot') {
        this.options.client.publish(
          `railway/state/${effect.entity_type}/${effect.entity_id}`,
          encodeJson(effect.state),
          { retain: true },
        );
      }
    }
  }

  private publishLayoutState(): void {
    this.options.client.publish(
      `railway/state/layout/${this.options.layout.name}`,
      encodeJson(this.options.layout),
      { retain: true },
    );
  }

  private encodeEvent(event_type: string, device_id: string, payload: unknown): Uint8Array {
    return encodeJson({
      event_id: this.newId(),
      device_id,
      timestamp_device: new Date().toISOString(),
      event_type,
      protocol_version: PROTOCOL_VERSION,
      payload,
    });
  }

  private encodeCommand(command_type: string, device_id: string, payload: unknown): Uint8Array {
    return encodeJson({
      command_id: this.newId(),
      device_id,
      timestamp_server: new Date().toISOString(),
      command_type,
      protocol_version: PROTOCOL_VERSION,
      payload,
    });
  }
}

function parseJsonEnvelope(payload: Uint8Array): IncomingEnvelope | null {
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
  if (typeof raw !== 'object' || raw === null) return null;
  return raw as IncomingEnvelope;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
