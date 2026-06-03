/**
 * Broker abstraction for the visualiser.
 *
 * The visualiser is mostly subscriber: it renders what the Trainframe system
 * publishes. Per ADR-013 it also publishes a small set of *operator intents*
 * (assign schedule, revoke clearance, …) on `railway/operator/<command>`
 * topics, which the scheduler — embedded in the simulator-ui or running in
 * `@trainframe/server` — subscribes to.
 *
 * The interface lives at the system boundary so production uses a real
 * MQTT-over-WebSockets client and tests use an in-memory stand-in.
 * Components depend on this interface, not on `mqtt` directly, so no test
 * ever opens a WebSocket.
 */

export type BrokerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface BrokerMessage {
  topic: string;
  payload: Uint8Array;
}

export type StatusListener = (status: BrokerStatus, error?: Error) => void;
export type MessageListener = (message: BrokerMessage) => void;

export interface PublishOptions {
  /**
   * If true the broker stores the message and forwards it to future
   * subscribers whose topic filter matches. Operator commands are usually
   * NOT retained — they're one-shot intents that should be re-issued by the
   * operator if needed.
   */
  readonly retain?: boolean;
}

export interface BrokerSubscriber {
  readonly status: BrokerStatus;
  connect(url: string): void;
  disconnect(): void;
  subscribe(topic: string, handler: MessageListener): () => void;
  publish(topic: string, payload: Uint8Array, options?: PublishOptions): void;
  onStatusChange(listener: StatusListener): () => void;
}
