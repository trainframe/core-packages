/**
 * MQTT topic-filter matching.
 *
 * Does `pattern` — an MQTT subscription filter that may contain the wildcards
 * `+` (exactly one level) and `#` (the trailing multi-level) — match the
 * concrete `topic` a message arrived on?
 *
 * Shared by every `BrokerClient` implementation so the in-memory test client
 * and the real MQTT-over-WS client agree on delivery. This is not a cosmetic
 * dedupe: the simulator's `BrokerBridge` subscribes to `railway/commands/#`,
 * and if the real client matched by exact string (as it once did) the in-browser
 * devices would receive no commands at all — a train could never be cleared to
 * move even though every test passed against the wildcard-aware in-memory client.
 */
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
