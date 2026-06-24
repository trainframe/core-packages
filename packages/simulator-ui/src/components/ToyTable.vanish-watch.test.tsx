import { act, render, screen } from '@testing-library/react';
/**
 * Proves the DEV vanish-watch (criterion 1's safety net) actually CAPTURES a
 * failing observation. The flex+add path is sound (see flex-add-vanish.* guards),
 * so the watch normally stays silent — but if a rendered piece ever goes
 * non-finite or flung far off-canvas, the watch must record it into
 * `window.__tfVanishLog` with the piece set + poses, so an intermittent live
 * "sometimes it vanishes" becomes concrete evidence instead of a shrug.
 *
 * We force the two failure shapes by staging a piece set that already contains a
 * non-finite / off-canvas piece (via the DEV `__tfLoadPieces` hook) and assert
 * the watch caught it. (We do NOT claim the flex path produces these — it
 * provably does not; this verifies the CAPTURE mechanism works.)
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-vanish-watch');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-vanish-watch" />
    </BrokerProvider>,
  );
}

const good = (id: string, x: number): TrackPiece => ({
  id,
  type: 'straight',
  position: { x, y: 300 },
  rotationDeg: 0,
  tagged: false,
});

describe('DEV vanish-watch captures a failing observation (criterion 1 net)', () => {
  beforeEach(() => {
    localStorage.clear();
    window.__tfVanishLog = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.__tfVanishLog = undefined;
  });

  it('stays silent for a healthy chain', () => {
    renderToyTable();
    act(() => window.__tfLoadPieces?.([good('P0', 150), good('P1', 350), good('P2', 550)]));
    expect(window.__tfVanishLog ?? []).toEqual([]);
  });

  it('captures a NON-FINITE piece with before/after evidence', () => {
    renderToyTable();
    act(() => window.__tfLoadPieces?.([good('P0', 150), good('P1', 350)]));
    // Now stage a set where P1 has gone to NaN — the "to NaN" failing shape.
    act(() =>
      window.__tfLoadPieces?.([
        good('P0', 150),
        {
          id: 'P1',
          type: 'straight',
          position: { x: Number.NaN, y: 300 },
          rotationDeg: 0,
          tagged: false,
        },
      ]),
    );
    const log = window.__tfVanishLog ?? [];
    const rec = log.find((r) => r.pieceId === 'P1' && r.reason === 'non-finite');
    expect(rec, 'a non-finite vanish was captured').toBeDefined();
    // Evidence: which piece, and the full before/after sets.
    expect(rec?.after.some((p) => p.id === 'P1')).toBe(true);
    expect(rec?.before.some((p) => p.id === 'P1')).toBe(true);
  });

  it('captures an OFF-CANVAS (flung) piece', () => {
    renderToyTable();
    act(() => window.__tfLoadPieces?.([good('P0', 150), good('P1', 350)]));
    act(() => window.__tfLoadPieces?.([good('P0', 150), good('P1', 99999)]));
    const log = window.__tfVanishLog ?? [];
    expect(log.some((r) => r.pieceId === 'P1' && r.reason === 'off-canvas')).toBe(true);
  });

  it('does NOT flag a legitimate removal (delete) — no false positives', () => {
    renderToyTable();
    act(() => window.__tfLoadPieces?.([good('P0', 150), good('P1', 350), good('P2', 550)]));
    // A piece leaving the set is an intentional delete (applyFlex never drops one),
    // so the watch must stay silent — otherwise normal editing floods the log.
    act(() => window.__tfLoadPieces?.([good('P0', 150), good('P2', 550)]));
    expect(window.__tfVanishLog ?? []).toEqual([]);
  });

  // Verify nothing prints to console — the watch is an inspectable window log,
  // not console noise.
  it('uses the window log, not console', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderToyTable();
    act(() => window.__tfLoadPieces?.([good('P0', 150), good('P1', 99999)]));
    expect(errSpy).not.toHaveBeenCalled();
  });
});
