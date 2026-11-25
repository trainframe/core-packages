import type { EnvelopeSource } from '@trainframe/simulator';

/** Browser entry point source: random UUID ids and real timestamps, so ids stay unique across page loads. */
export const wallClockEnvelopeSource: EnvelopeSource = {
  newId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};
