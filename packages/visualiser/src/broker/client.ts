/**
 * Broker abstraction for the visualiser.
 *
 * The visualiser is subscriber-only: it never publishes. The interface lives at
 * the system boundary so production uses a real MQTT-over-WebSockets client
 * and tests use an in-memory stand-in. Components depend on this interface,
 * not on `mqtt` directly, so no test ever opens a WebSocket.
 */

export type BrokerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface BrokerMessage {
  topic: string;
  payload: Uint8Array;
}

export type StatusListener = (status: BrokerStatus, error?: Error) => void;
export type MessageListener = (message: BrokerMessage) => void;

export interface BrokerSubscriber {
  readonly status: BrokerStatus;
  connect(url: string): void;
  disconnect(): void;
  subscribe(topic: string, handler: MessageListener): () => void;
  onStatusChange(listener: StatusListener): () => void;
}
