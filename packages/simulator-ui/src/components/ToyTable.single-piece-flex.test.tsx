import { act, render, screen } from '@testing-library/react';
/**
 * Goal Part 1: flex is meaningless for a piece on no flexable chain. Pressing and
 * holding such a piece must NOT enter flex — a hold-then-drag must MOVE it and the
 * move must COMMIT (not spring back). Reproduces the reported bug first: a lone
 * piece held-then-dragged springs back to its origin because the hold-dwell
 * engaged flex mode unconditionally and the flex release path discards the move.
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;
const SCALE = 2;

/* A SINGLE unconnected piece — no chain, so flex has nothing to bend. */
const LONE: ReadonlyArray<TrackPiece> = [
  { id: 'X', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
];

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-single-flex');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-single-flex" />
    </BrokerProvider>,
  );
}

function mockCanvasRect(): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: CANVAS_W_MM * SCALE,
    bottom: CANVAS_H_MM * SCALE,
    width: CANVAS_W_MM * SCALE,
    height: CANVAS_H_MM * SCALE,
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

function poseOf(canvas: Element, id: string): { x: number; y: number } {
  const t = canvas.querySelector(`[data-piece-id="${id}"]`)?.getAttribute('transform') ?? '';
  const tr = /translate\(([-\d.]+),?\s*([-\d.]+)\)/.exec(t);
  return {
    x: tr ? Number.parseFloat(tr[1] ?? '0') : 0,
    y: tr ? Number.parseFloat(tr[2] ?? '0') : 0,
  };
}

describe('single-piece flex — a lone piece holds-then-moves, never flexes (Part 1)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('press-hold-drag on a lone piece MOVES it and the move stays committed (no spring-back)', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(LONE));

      const x = canvas.querySelector('[data-piece-id="X"]');
      if (x === null) throw new Error('X not rendered');

      // Press and HOLD past the flex dwell (the gesture an operator does when
      // they pause before dragging), then drag to a new spot and release.
      act(() => x.dispatchEvent(ptr('pointerdown', 300 * SCALE, 300 * SCALE)));
      act(() => vi.advanceTimersByTime(300)); // past FLEX_HOLD_MS
      act(() => x.dispatchEvent(ptr('pointermove', 600 * SCALE, 420 * SCALE)));
      act(() => x.dispatchEvent(ptr('pointerup', 600 * SCALE, 420 * SCALE)));

      // The lone piece must have RELOCATED toward the drop point and STAYED —
      // not sprung back to its origin (300,300).
      const pose = poseOf(canvas, 'X');
      expect(Math.hypot(pose.x - 300, pose.y - 300), 'piece left its origin').toBeGreaterThan(100);
      expect(
        Math.hypot(pose.x - 600, pose.y - 420),
        'piece committed near the drop point',
      ).toBeLessThan(80);
    } finally {
      restore();
    }
  });

  it('a lone piece never shows the flex ripple on hold (flex is disabled for it)', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(LONE));
      const x = canvas.querySelector('[data-piece-id="X"]');
      if (x === null) throw new Error('X not rendered');

      act(() => x.dispatchEvent(ptr('pointerdown', 300 * SCALE, 300 * SCALE)));
      act(() => vi.advanceTimersByTime(300));
      // No flex-mode ripple should have been emitted for a non-flexable piece.
      expect(document.querySelector('[data-testid="flex-ripple"]')).toBeNull();
      act(() => x.dispatchEvent(ptr('pointerup', 300 * SCALE, 300 * SCALE)));
    } finally {
      restore();
    }
  });
});
