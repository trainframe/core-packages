import type {
  BrokerMessage,
  BrokerStatus,
  BrokerSubscriber,
  MessageListener,
  PublishOptions,
  StatusListener,
} from './client.js';

/**
 * Synchronous in-memory `BrokerSubscriber` for tests. Drives the same observable
 * surface as the MQTT-backed client (status events, topic subscriptions) without
 * any network I/O, so component tests can assert on what users see when the
 * broker connects, drops, or delivers a message.
 *
 * Topic matching supports MQTT wildcards `+` (single level) and `#` (multi-level
 * trailing). Exact-string matches still work — wildcards only kick in when present.
 */
export class InMemoryBrokerSubscriber implements BrokerSubscriber {
  private currentStatus: BrokerStatus = 'disconnected';
  private readonly subs = new Map<string, Set<MessageListener>>();
  private readonly statusListeners = new Set<StatusListener>();
  /** Test-readable log of every publish made through this client. */
  readonly published: Array<BrokerMessage & { retain: boolean }> = [];

  get status(): BrokerStatus {
    return this.currentStatus;
  }

  connect(_url: string): void {
    this.setStatus('connecting');
    this.setStatus('connected');
  }

  disconnect(): void {
    this.setStatus('disconnected');
  }

  subscribe(topic: string, handler: MessageListener): () => void {
    let bucket = this.subs.get(topic);
    if (!bucket) {
      bucket = new Set();
      this.subs.set(topic, bucket);
    }
    bucket.add(handler);
    return () => {
      bucket?.delete(handler);
      if (bucket && bucket.size === 0) this.subs.delete(topic);
    };
  }

  publish(topic: string, payload: Uint8Array, options?: PublishOptions): void {
    const retain = options?.retain ?? false;
    this.published.push({ topic, payload, retain });
    // Echo the publish back to any subscribers — both for retained messages
    // (where this is what subscribers want anyway) and for operator commands
    // (so a test that observes the same in-memory broker on both ends sees
    // the round-trip).
    this.deliver({ topic, payload });
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Test-only: deliver a message as if the broker forwarded it. */
  deliver(message: BrokerMessage): void {
    for (const [pattern, listeners] of this.subs) {
      if (matchesTopic(pattern, message.topic)) {
        for (const handler of listeners) handler(message);
      }
    }
  }

  /** Test-only: simulate a connection error. */
  fail(error: Error): void {
    this.currentStatus = 'error';
    for (const listener of this.statusListeners) listener('error', error);
  }

  private setStatus(next: BrokerStatus): void {
    this.currentStatus = next;
    for (const listener of this.statusListeners) listener(next);
  }
}

export function matchesTopic(pattern: string, topic: string): boolean {
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
