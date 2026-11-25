/** The id and timestamp sources every device and platform stamps envelopes with. */
export interface EnvelopeSource {
  readonly newId: () => string;
  readonly now: () => string;
}

/**
 * A reproducible envelope source: ids count up from 1 under `prefix` and each
 * timestamp is one millisecond after the previous, starting at the epoch. Two
 * sources with different prefixes never collide on id.
 */
export function deterministicEnvelopeSource(prefix = 'id'): EnvelopeSource {
  let idCount = 0;
  let tickMs = 0;
  return {
    newId: () => {
      idCount += 1;
      return `${prefix}-${idCount}`;
    },
    now: () => new Date(tickMs++).toISOString(),
  };
}
