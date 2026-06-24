import { act, render, screen } from '@testing-library/react';
/**
 * Feature B (criteria 4 & 5): a parts-menu drag carries the REAL piece onto the
 * table — no static drag-image placeholder — and R rotates / F flips it DURING
 * that first drag, before it's dropped. On release it commits at the chosen
 * orientation. This test drives the drag, orients it mid-flight, drops it in open
 * space (no snap), and asserts the committed rotation + flipped state match the
 * in-flight choices. It also asserts no native HTML5 drag-image is used (the
 * toybox tiles are not `draggable`).
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const CANVAS_W = 900;
const CANVAS_H = 600;
const SCALE = 2;

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-toybox-drag');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-toybox-drag" />
    </BrokerProvider>,
  );
}

function mockCanvasRect(): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: CANVAS_W * SCALE,
    bottom: CANVAS_H * SCALE,
    width: CANVAS_W * SCALE,
    height: CANVAS_H * SCALE,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return () => spy.mockRestore();
}

function pointer(type: string, xPx: number, yPx: number): Event {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: xPx,
    clientY: yPx,
  });
}

function key(k: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

interface Pose {
  id: string;
  deg: number;
  flipped: boolean;
}

function readPiece(canvas: Element, id: string): Pose | undefined {
  const el = canvas.querySelector(`[data-piece-id="${id}"]`);
  if (el === null) return undefined;
  const t = el.getAttribute('transform') ?? '';
  const ro = /rotate\(([-\d.eE]+)/.exec(t);
  // Flip renders as `scale(1, -1)` in the piece transform.
  const sc = /scale\(1,\s*(-?[\d.]+)\)/.exec(t);
  return {
    id,
    deg: ro ? Number.parseFloat(ro[1] ?? 'NaN') : Number.NaN,
    flipped: sc ? Number.parseFloat(sc[1] ?? '1') < 0 : false,
  };
}

describe('parts-menu drag carries the real piece, orientable in-flight (criteria 4/5)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('toybox tiles are NOT native-draggable (no static drag-image ghost)', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const tile = screen.getByTestId('toybox-curve');
      expect(tile.getAttribute('draggable')).not.toBe('true');
    } finally {
      restore();
    }
  });

  it('dragging a curve from the menu places the REAL piece following the cursor, R+F orient it in-flight, drop commits the chosen orientation', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      const tile = screen.getByTestId('toybox-curve');

      // Press on the tile, then move onto the canvas (open space) → the REAL
      // piece appears and follows the cursor (no ghost image).
      act(() => tile.dispatchEvent(pointer('pointerdown', 5, 5)));
      act(() => window.dispatchEvent(pointer('pointermove', 300 * SCALE, 300 * SCALE)));

      const idsAfterEnter = [...canvas.querySelectorAll('[data-piece-id]')].map((el) =>
        el.getAttribute('data-piece-id'),
      );
      expect(idsAfterEnter, 'the real piece is on the table mid-drag').toHaveLength(1);
      const id = idsAfterEnter[0];
      if (!id) throw new Error('no in-flight piece');

      const before = readPiece(canvas, id);
      if (before === undefined) throw new Error('in-flight piece not rendered');

      // Rotate twice (R) and flip once (F) DURING the drag.
      key('r');
      key('r');
      key('f');
      // Refresh the preview at the same open-space point so it reflects R/F.
      act(() => window.dispatchEvent(pointer('pointermove', 300 * SCALE, 300 * SCALE)));

      // Drop in open space (no snap target nearby) → commit at the chosen orientation.
      act(() => window.dispatchEvent(pointer('pointerup', 300 * SCALE, 300 * SCALE)));

      const committed = readPiece(canvas, id);
      if (committed === undefined) throw new Error('committed piece vanished');
      // Two rotations from 0° (45° steps) ⇒ 90°; flipped toggled once ⇒ true.
      expect(committed.deg, 'committed rotation matches the in-flight R presses').toBe(90);
      expect(committed.flipped, 'committed flipped matches the in-flight F press').toBe(true);
      // Still exactly one piece — the dragged piece committed, nothing duplicated.
      expect([...canvas.querySelectorAll('[data-piece-id]')]).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
