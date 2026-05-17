import mqtt, { type MqttClient } from 'mqtt';
import type { BrokerClient, BrokerMessage, MessageListener, PublishOptions } from './client.js';

/**
 * Production `BrokerClient` backed by `mqtt` over TCP. Tests should use
 * `InMemoryBrokerClient` instead for unit-level dispatch tests; the
 * integration package uses this client (via aedes) for cross-package flows.
 */
export class MqttBrokerClient implements BrokerClient {
  private client: MqttClient | null = null;
  private readonly subs = new Map<string, Set<MessageListener>>();

  async connect(url: string): Promise<void> {
    if (this.client) await this.disconnect();
    return new Promise((resolve, reject) => {
      // MQTT 3.1.1 — universally supported (Mosquitto default, aedes default).
      // Moving to MQTT 5 is a separate decision; see protocol-v0.2's "Open
      // questions for v0.3" on request/response patterns.
      const client = mqtt.connect(url, { protocolVersion: 4, reconnectPeriod: 0 });
      this.client = client;

      client.once('connect', () => {
        client.on('message', (topic, payload) => {
          const message = { topic, payload: new Uint8Array(payload) };
          for (const [pattern, listeners] of this.subs) {
            if (matchesTopic(pattern, topic)) {
              for (const handler of listeners) handler(message);
            }
          }
        });
        // Re-subscribe to any topics that were registered before connect.
        for (const topic of this.subs.keys()) client.subscribe(topic);
        resolve();
      });
      client.once('error', (err) => reject(err));
    });
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    return new Promise((resolve) => {
      client.end(false, {}, () => resolve());
    });
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
    // mqtt accepts Uint8Array via Buffer-compatible interface; cast for types.
    this.client?.publish(topic, payload as unknown as Buffer, {
      retain: options?.retain ?? false,
      qos: 1,
    });
  }
}

function matchesTopic(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (!pattern.includes('+') && !pattern.includes('#')) return false;
  const patternParts = pattern.split('/');
  const topicParts = topic.split('/');
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p === '#') return true;
    if (i >= topicParts.length) return false;
    if (p !== '+' && p !== topicParts[i]) return false;
  }
  return patternParts.length === topicParts.length;
}
