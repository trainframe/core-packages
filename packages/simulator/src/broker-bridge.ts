import { PROTOCOL_VERSION, parseEventTopic, subscriptions, topics } from '@trainframe/protocol';
import type { CapturedEvent, Simulation } from './simulation.js';

/**
 * Minimal broker abstraction the bridge needs. Structurally compatible with
 * `MqttBrokerClient` and `InMemoryBrokerClient`. We don't import either to
 * keep the simulator independent of the server and the simulator-ui.
 */
export interface BrokerLike {
  subscribe(
    topic: string,
    handler: (message: { topic: string; payload: Uint8Array }) => void,
  ): () => void;
  publish(topic: string, payload: Uint8Array, options?: { retain?: boolean }): void;
}

export interface BrokerBridgeOptions {
  /**
   * Function returning a fresh ID (UUID-shaped string) for event/command
   * envelopes. Pass a seeded generator in deterministic tests.
   */
  newId: () => string;
  /**
   * Function returning the current ISO-8601 timestamp for envelopes. Defaults
   * to `new Date().toISOString()`; pass a virtual clock in deterministic tests.
   */
  now?: () => string;
}

/**
 * Bridges a `Simulation` (running in device-only mode) onto a broker. Devices
 * emit events that the bridge publishes as `railway/events/{type}/{device}`;
 * commands published to `railway/commands/{device}` are routed back to the
 * simulation via `simulation.handleCommand()`.
 *
 * This is the seam that lets the simulator stand in for physical hardware
 * against a real server: the server schedules, the simulation supplies the
 * physics. No embedded scheduler is involved.
 */
export class BrokerBridge {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(
    private readonly simulation: Simulation,
    private readonly broker: BrokerLike,
    options: BrokerBridgeOptions,
  ) {
    this.newId = options.newId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Start forwarding in both directions. Idempotent. */
  start(): void {
    if (this.unsubscribers.length > 0) return;

    this.unsubscribers.push(this.simulation.onEvent((event) => this.publishEvent(event)));

    this.unsubscribers.push(
      this.broker.subscribe(subscriptions.allCommands, (message) => {
        this.handleCommandMessage(message.topic, message.payload);
      }),
    );
  }

  /** Stop forwarding. Safe to call before `start` or twice. */
  stop(): void {
    while (this.unsubscribers.length > 0) {
      const unsubscribe = this.unsubscribers.pop();
      unsubscribe?.();
    }
  }

  private publishEvent(event: CapturedEvent): void {
    if (event.device_id === 'server') return;
    if (parseEventTopic(`railway/events/${event.event_type}/${event.device_id}`) === null) return;
    const envelope = {
      event_id: this.newId(),
      device_id: event.device_id,
      timestamp_device: this.now(),
      event_type: event.event_type,
      protocol_version: PROTOCOL_VERSION,
      payload: event.payload,
    };
    this.broker.publish(
      topics.event(event.event_type, event.device_id),
      utf8Encode(JSON.stringify(envelope)),
    );
  }

  private handleCommandMessage(topic: string, payload: Uint8Array): void {
    const parts = topic.split('/');
    if (parts.length !== 3 || parts[0] !== 'railway' || parts[1] !== 'commands') return;
    const device_id = parts[2];
    if (!device_id) return;

    const text = utf8Decode(payload);
    const parsed = safeParseJson(text);
    if (parsed === null) return;
    const command_type = typeof parsed.command_type === 'string' ? parsed.command_type : undefined;
    if (!command_type) return;

    this.simulation.handleCommand(device_id, command_type, parsed.payload);
  }
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
