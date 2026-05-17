/**
 * Broker abstraction for the server. Same shape as the simulator-ui's client —
 * we don't share a package today (the simulator-ui's lives in a browser
 * package; the server's runs on Node). When a third consumer needs the same
 * abstraction, factor out a `@trainframe/broker-client` package.
 */

export interface BrokerMessage {
  readonly topic: string;
  readonly payload: Uint8Array;
}

export type MessageListener = (message: BrokerMessage) => void;

export interface PublishOptions {
  readonly retain?: boolean;
}

export interface BrokerClient {
  connect(url: string): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic: string, handler: MessageListener): () => void;
  publish(topic: string, payload: Uint8Array, options?: PublishOptions): void;
}
