import mqtt, { type MqttClient } from 'mqtt';
import type {
  BrokerClient,
  BrokerStatus,
  MessageListener,
  PublishOptions,
  StatusListener,
} from './client.js';
import { matchesTopic } from './topic-match.js';

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

    // MQTT 3.1.1 (protocolVersion: 4) to keep compatibility with brokers that
    // don't yet speak v5 (notably aedes, which we use in tests). Switch to 5
    // once we adopt a broker that requires it.
    const client = mqtt.connect(url, { protocolVersion: 4, reconnectPeriod: 2000 });
    this.client = client;

    client.on('connect', () => {
      if (this.client !== client) return;
      this.setStatus('connected');
      for (const topic of this.subs.keys()) client.subscribe(topic);
    });
    client.on('reconnect', () => {
      if (this.client !== client) return;
      this.setStatus('connecting');
    });
    // In the browser the mqtt library does not emit 'error' for WebSocket
    // connection failures (the error object has no `.code`, so mqtt silently
    // swallows it). Surface the failure via 'close' instead: if the socket
    // closes while we are still in the 'connecting' state we never reached the
    // broker — treat that as an error. A close from a previously 'connected'
    // socket is a normal disconnection. Guard against stale events from a
    // superseded client (the old client fires 'close' after end(true) even
    // though connect() has already created a new one).
    client.on('close', () => {
      if (this.client !== client) return;
      if (this.currentStatus === 'connecting') {
        this.setStatus('error', new Error("Couldn't reach the broker — check the URL."));
      } else if (this.currentStatus !== 'error') {
        this.setStatus('disconnected');
      }
    });
    client.on('error', (error) => {
      if (this.client !== client) return;
      this.setStatus('error', error);
    });
    client.on('message', (topic, payload) => {
      // Dispatch by MQTT topic-filter match, not exact string: a single
      // wildcard subscription (e.g. the simulator bridge's `railway/commands/#`)
      // must receive every concrete topic beneath it. Mirrors the in-memory
      // client's `deliver` so both clients agree on delivery.
      const message = { topic, payload: new Uint8Array(payload) };
      for (const [pattern, bucket] of this.subs) {
        if (!matchesTopic(pattern, topic)) continue;
        for (const handler of bucket) handler(message);
      }
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
