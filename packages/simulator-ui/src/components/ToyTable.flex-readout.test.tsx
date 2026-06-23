import { act, render, screen } from '@testing-library/react';
/**
 * Flex-angle readout (goal criterion A / 1).
 *
 * The top-right readout must (a) LIVE-update while the operator flexes a piece —
 * reflecting the current bend in real time, not only on release — and (b) always
 * show exactly two decimal places (e.g. `4.53°`), including `0.00°` at rest.
 *
 * Driven through the real rendered component.
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const SCALE = 2;

/* Two straights chained end-to-end: A east end at (400,300) meets B west end. */
const TWO_STRAIGHT_CHAIN: ReadonlyArray<TrackPiece> = [
  { id: 'A', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'B', type: 'straight', position: { x: 500, y: 300 }, rotationDeg: 0, tagged: false },
];

/** Matches a bare angle to EXACTLY two decimal places, e.g. "0.00°", "-4.53°". */
const TWO_DP = /^-?\d+\.\d{2}°?$/;

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-readout');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-readout" />
    </BrokerProvider>,
  );
}

function mockCanvasRect(): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 900 * SCALE,
    bottom: 600 * SCALE,
    width: 900 * SCALE,
    height: 600 * SCALE,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return () => spy.mockRestore();
}

function ptr(type: string, xPx: number, yPx: number): Event {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: xPx,
    clientY: yPx,
  });
}

function readout(): string {
  return (screen.getByTestId('flex-angle-readout').textContent ?? '').trim();
}

describe('flex-angle readout — live + 2dp (criterion A)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads 0.00° at rest and live-updates to a 2dp value as a piece is flexed', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(TWO_STRAIGHT_CHAIN));

      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');

      // Select B with a plain click (no drag) → at rest the readout reads 0.00°
      // (exactly two decimals), not a bare integer.
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 500 * SCALE, 300 * SCALE)));
      expect(readout()).toMatch(TWO_DP);
      expect(readout()).toBe('0.00°');

      // Hold to engage flex, then drag through TWO distinct positions; the readout
      // must change between them (live) and stay 2dp at every sample.
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => vi.advanceTimersByTime(300)); // past FLEX_HOLD_MS → flex mode

      // A small bend (well under the ~5° per-joint budget), then a larger one, so
      // the two samples genuinely differ (a saturated bend would read the same).
      act(() => b.dispatchEvent(ptr('pointermove', 500 * SCALE, 306 * SCALE)));
      const atPos1 = readout();
      expect(atPos1).toMatch(TWO_DP);

      act(() => b.dispatchEvent(ptr('pointermove', 500 * SCALE, 345 * SCALE)));
      const atPos2 = readout();
      expect(atPos2).toMatch(TWO_DP);

      // LIVE: the readout tracked the deepening bend between the two drag points.
      expect(atPos1).not.toBe('0.00°');
      expect(atPos2).not.toBe(atPos1);

      act(() => b.dispatchEvent(ptr('pointerup', 500 * SCALE, 370 * SCALE)));
      // Still 2dp after the bend is baked.
      expect(readout()).toMatch(TWO_DP);
    } finally {
      restore();
    }
  });
});
