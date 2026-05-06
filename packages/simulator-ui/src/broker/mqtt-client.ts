import mqtt, { type MqttClient } from 'mqtt';
import type {
  BrokerClient,
  BrokerStatus,
  MessageListener,
  PublishOptions,
  StatusListener,
} from './client.js';

/**
 * Production `BrokerClient` backed by `mqtt` over WebSockets.
 * Tests should use `InMemoryBrokerClient` instead — this client opens a real
 * socket and is only exercised in the running browser app.
 */
export class MqttBrokerClient implements BrokerClient {
  private client: MqttClient | null = null;
  private currentStatus: BrokerStatus = 'disconnected';
  private readonly subs = new Map<string, Set<MessageListener>>();
  private readonly statusListeners = new Set<StatusListener>();

  get status(): BrokerStatus {
    return this.currentStatus;
  }

  connect(url: string): void {
    this.disconnect();
    this.setStatus('connecting');

    const client = mqtt.connect(url, { protocolVersion: 5, reconnectPeriod: 2000 });
    this.client = client;

    client.on('connect', () => {
      this.setStatus('connected');
      for (const topic of this.subs.keys()) client.subscribe(topic);
    });
    client.on('reconnect', () => this.setStatus('connecting'));
    client.on('close', () => this.setStatus('disconnected'));
    client.on('error', (error) => this.setStatus('error', error));
    client.on('message', (topic, payload) => {
      const bucket = this.subs.get(topic);
      if (!bucket) return;
      const message = { topic, payload: new Uint8Array(payload) };
      for (const handler of bucket) handler(message);
    });
  }

  disconnect(): void {
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    this.setStatus('disconnected');
  }

  subscribe(topic: string, handler: MessageListener): () => void {
    let bucket = this.subs.get(topic);
    if (!bucket) {
      bucket = new Set();
      this.subs.set(topic, bucket);
      this.client?.subscribe(topic);
    }
    bucket.add(handler);
    return () => {
      bucket?.delete(handler);
      if (bucket && bucket.size === 0) {
        this.subs.delete(topic);
        this.client?.unsubscribe(topic);
      }
    };
  }

  publish(topic: string, payload: Uint8Array, options?: PublishOptions): void {
    // mqtt accepts Uint8Array directly in browser builds (Buffer is a Node global).
    this.client?.publish(topic, payload as unknown as Buffer, { retain: options?.retain ?? false });
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(next: BrokerStatus, error?: Error): void {
    this.currentStatus = next;
    for (const listener of this.statusListeners) listener(next, error);
  }
}
