import type {
  BrokerMessage,
  BrokerStatus,
  BrokerSubscriber,
  MessageListener,
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
