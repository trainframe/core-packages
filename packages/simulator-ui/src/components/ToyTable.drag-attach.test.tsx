import { act, render, screen } from '@testing-library/react';
/**
 * Goal Part 2: dragging a piece OUT of the parts menu (Feature-B pointer drag)
 * and dropping it against an existing open end must attach it in ONE action — no
 * vanish. Reproduces the reported bug first: the dragged piece disappears when
 * dropped onto an occupied open end (the workaround is drop-in-open-space then
 * drag again). Drives the real Feature-B gesture (tile pointerdown → window
 * pointermove onto the table → window pointerup on the neighbour's open end).
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { connectedComponents } from '@trainframe/simulator/track/loops.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;
const SCALE = 2;

/* One existing straight; its east open end is at ~(400, 300). */
const EXISTING: ReadonlyArray<TrackPiece> = [
  { id: 'E', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
];

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-drag-attach');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-drag-attach" />
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

function pointer(type: string, xPx: number, yPx: number): Event {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: xPx,
    clientY: yPx,
  });
}

function ids(canvas: Element): string[] {
  return [...canvas.querySelectorAll('[data-piece-id]')].map((el) => el.getAttribute('data-piece-id') ?? '');
}

function asPieces(canvas: Element): TrackPiece[] {
  return [...canvas.querySelectorAll('[data-piece-id]')].map((el) => {
    const t = el.getAttribute('transform') ?? '';
    const tr = /translate\(([-\d.eE]+),?\s*([-\d.eE]+)\)/.exec(t);
    const ro = /rotate\(([-\d.eE]+)/.exec(t);
    return {
      id: el.getAttribute('data-piece-id') ?? '',
      type: 'straight' as const,
      position: {
        x: tr ? Number.parseFloat(tr[1] ?? 'NaN') : Number.NaN,
        y: tr ? Number.parseFloat(tr[2] ?? 'NaN') : Number.NaN,
      },
      rotationDeg: ro ? Number.parseFloat(ro[1] ?? '0') : 0,
      tagged: false,
    };
  });
}

describe('drag-from-menu attaches against an existing piece (Part 2)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a menu-drag dropped onto an occupied open end keeps both pieces, connected', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(EXISTING));
      expect(ids(canvas)).toEqual(['E']);

      const tile = screen.getByTestId('toybox-straight');
      // Feature-B drag: press the tile, move onto the table near E's east open
      // end (~400,300), and release there to attach.
      act(() => tile.dispatchEvent(pointer('pointerdown', 5, 5)));
      act(() => window.dispatchEvent(pointer('pointermove', 420 * SCALE, 300 * SCALE)));
      act(() => window.dispatchEvent(pointer('pointermove', 410 * SCALE, 300 * SCALE)));
      act(() => window.dispatchEvent(pointer('pointerup', 410 * SCALE, 300 * SCALE)));

      const after = ids(canvas);
      // The dragged piece must NOT have vanished — two pieces remain.
      expect(after, `both pieces present (got ${JSON.stringify(after)})`).toHaveLength(2);
      const pieces = asPieces(canvas);
      for (const p of pieces) {
        expect(Number.isFinite(p.position.x) && Number.isFinite(p.position.y), `${p.id} finite`).toBe(true);
      }
      // And they attached: one connected component.
      expect(connectedComponents(pieces).length, 'attached into one component').toBe(1);
    } finally {
      restore();
    }
  });
});
