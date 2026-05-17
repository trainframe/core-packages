import type { BrokerClient, BrokerMessage, MessageListener, PublishOptions } from './client.js';

/**
 * In-memory `BrokerClient` for unit tests. Models retain semantics: retained
 * messages are stored per topic and replayed to any later subscription whose
 * filter matches. `+` and `#` wildcards are supported in subscription filters.
 *
 * `published` is the recorded history (in publish order); inspect for assertions.
 */
export class InMemoryBrokerClient implements BrokerClient {
  private readonly subs = new Map<string, Set<MessageListener>>();
  private readonly retained = new Map<string, BrokerMessage>();
  readonly published: BrokerMessage[] = [];

  // The interface signature is async to match the mqtt-backed client; in-memory
  // resolves immediately.
  async connect(_url: string): Promise<void> {
    return Promise.resolve();
  }

  async disconnect(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(topic: string, handler: MessageListener): () => void {
    let bucket = this.subs.get(topic);
    if (!bucket) {
      bucket = new Set();
      this.subs.set(topic, bucket);
    }
    bucket.add(handler);
    for (const [retainedTopic, message] of this.retained) {
      if (matchesTopic(topic, retainedTopic)) handler(message);
    }
    return () => {
      bucket?.delete(handler);
      if (bucket && bucket.size === 0) this.subs.delete(topic);
    };
  }

  publish(topic: string, payload: Uint8Array, options?: PublishOptions): void {
    const message = { topic, payload };
    this.published.push(message);
    if (options?.retain) this.retained.set(topic, message);
    for (const [pattern, listeners] of this.subs) {
      if (matchesTopic(pattern, topic)) {
        for (const handler of listeners) handler(message);
      }
    }
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
