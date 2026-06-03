import mqtt, { type MqttClient } from 'mqtt';
import type {
  BrokerStatus,
  BrokerSubscriber,
  MessageListener,
  PublishOptions,
  StatusListener,
} from './client.js';
import { matchesTopic } from './in-memory-client.js';

/**
 * Production `BrokerSubscriber` backed by `mqtt` over WebSockets.
 * Tests should use `InMemoryBrokerSubscriber` instead — this client opens a
 * real socket and is only exercised in the running browser app.
 */
export class MqttBrokerSubscriber implements BrokerSubscriber {
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

    // MQTT 3.1.1 for parity with the simulator-ui client; aedes (our test
    // broker) doesn't speak v5 yet. Bump to 5 when the broker side catches up.
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
      // Match the concrete inbound topic against every subscription pattern.
      // The `mqtt` library only fires `message` for topics that matched some
      // subscription, so we can't skip this step - the subscription key in
      // `subs` is the pattern (e.g. `railway/events/anomaly/+`), and the
      // inbound topic is the concrete value (e.g. `.../server`).
      const message = { topic, payload: new Uint8Array(payload) };
      for (const [pattern, bucket] of this.subs) {
        if (matchesTopic(pattern, topic)) {
          for (const handler of bucket) handler(message);
        }
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
    if (!this.client) return;
    // Decode to a UTF-8 string before publishing: mqtt.js's Node-flavoured
    // types want `string | Buffer`, and Buffer is not available in the
    // browser without a polyfill. Our payloads are always JSON-encoded
    // UTF-8 bytes, so the round-trip is lossless.
    const text = new TextDecoder().decode(payload);
    this.client.publish(topic, text, { retain: options?.retain ?? false });
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
