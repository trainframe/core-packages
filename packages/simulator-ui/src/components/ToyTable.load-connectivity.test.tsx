import { render, screen } from '@testing-library/react';
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { normalizeJointGaps } from '@trainframe/simulator/track/normalize.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
/**
 * Part 3 integration: a saved layout LOADED through the real wiring renders
 * connected. Seeds the autosave with the raw fixture (which carries residual
 * loop-closing gaps up to 22.5mm), mounts ToyTable so `restoreAutosaveSeeds`
 * rehydrates it, and asserts each piece renders at the NORMALISED pose — proving
 * the gap-close (verified to render connected in the simulator's
 * `layout-connectivity.test.ts`) runs on the path an operator actually loads
 * through, not just in the pure function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rawFixture from '../../../../test-track-layout.json';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';
import { AUTOSAVE_KEY } from './track-storage.js';

const FIXTURE = rawFixture as TrackPiece[];

/* Rendered translate(x,y) of the piece group, or null. */
function renderedPos(id: string): { x: number; y: number } | null {
  const el = document.querySelector(`[data-piece-id="${id}"]`);
  const tr = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(el?.getAttribute('transform') ?? '');
  return tr === null
    ? null
    : { x: Number.parseFloat(tr[1] ?? '0'), y: Number.parseFloat(tr[2] ?? '0') };
}

describe('Part 3 — a loaded saved layout renders connected (integration)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('rehydrating the autosaved fixture renders every piece at its gap-closed pose', () => {
    // Seed the autosave with the raw (gappy) fixture, as a page reload would find it.
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ pieces: FIXTURE, undo: [] }));

    const client = new InMemoryBrokerClient();
    client.connect('ws://test-load-conn');
    render(
      <BrokerProvider client={client}>
        <ToyTable initialUrl="ws://test-load-conn" />
      </BrokerProvider>,
    );

    expect(screen.getAllByTestId(/^piece-/).length).toBeGreaterThan(0);

    // Every piece renders at the pose normalizeJointGaps produces (not its raw
    // pose) — so the load path applied the gap-close. At least one piece must have
    // actually moved (else the assertion is vacuous on an already-flush layout).
    const normalized = normalizeJointGaps(FIXTURE);
    const rawById = new Map(FIXTURE.map((p) => [p.id, p]));
    let moved = 0;
    for (const np of normalized) {
      const r = renderedPos(np.id);
      if (r === null) continue; // train/carriage render at sim pose; skip those
      expect(
        Math.hypot(r.x - np.position.x, r.y - np.position.y),
        `${np.id} renders at its normalised pose`,
      ).toBeLessThan(1);
      const raw = rawById.get(np.id);
      if (
        raw !== undefined &&
        Math.hypot(raw.position.x - np.position.x, raw.position.y - np.position.y) > 1
      ) {
        moved += 1;
      }
    }
    expect(moved, 'normalisation moved at least one piece on load').toBeGreaterThan(0);
  });
});
