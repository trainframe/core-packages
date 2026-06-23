import { act, fireEvent, render, screen } from '@testing-library/react';
/**
 * Named-slot save/load + autosave with undo-history persistence (goal criteria
 * 3, 4, 5). Driven through the real rendered component; pure localStorage, no
 * broker. A "reload" is a real unmount + remount reading the SAME localStorage.
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const SCALE = 2;

const CHAIN: ReadonlyArray<TrackPiece> = [
  { id: 'A', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'B', type: 'straight', position: { x: 500, y: 300 }, rotationDeg: 0, tagged: false },
];
const SINGLE: ReadonlyArray<TrackPiece> = [
  { id: 'X', type: 'straight', position: { x: 200, y: 200 }, rotationDeg: 0, tagged: false },
];

function renderToyTable(): { unmount: () => void } {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-save');
  const view = render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-save" />
    </BrokerProvider>,
  );
  return { unmount: view.unmount };
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

function getCanvas(): Element {
  return screen.getByTestId('toy-table-canvas') as unknown as Element;
}

function poseOf(canvas: Element, id: string): { x: number; y: number; deg: number } {
  const el = canvas.querySelector(`[data-piece-id="${id}"]`);
  const t = el?.getAttribute('transform') ?? '';
  const tr = /translate\(([-\d.]+),?\s*([-\d.]+)\)/.exec(t);
  const ro = /rotate\(([-\d.]+)/.exec(t);
  return {
    x: tr ? Number.parseFloat(tr[1] ?? '0') : 0,
    y: tr ? Number.parseFloat(tr[2] ?? '0') : 0,
    deg: ro ? Number.parseFloat(ro[1] ?? '0') : 0,
  };
}

function committed(canvas: Element): Array<{ id: string; x: number; y: number; deg: number }> {
  return [...canvas.querySelectorAll('[data-piece-id]')]
    .map((el) => ({
      id: el.getAttribute('data-piece-id') ?? '',
      ...poseOf(canvas, el.getAttribute('data-piece-id') ?? ''),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function ids(canvas: Element): string[] {
  return [...canvas.querySelectorAll('[data-piece-id]')]
    .map((el) => el.getAttribute('data-piece-id') ?? '')
    .sort();
}

const undoDepth = (): number => window.__tfUndoDepth?.() ?? -1;
const load = (pieces: ReadonlyArray<TrackPiece>): void =>
  act(() => window.__tfLoadPieces?.(pieces));
const pressCmdZ = (): void => {
  act(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })),
  );
};

/** A move-drag of B to (toXmm,toYmm) — one committed edit. */
function moveB(canvas: Element, fromX: number, fromY: number, toX: number, toY: number): void {
  const b = canvas.querySelector('[data-piece-id="B"]');
  if (b === null) throw new Error('B not rendered');
  act(() => b.dispatchEvent(ptr('pointerdown', fromX * SCALE, fromY * SCALE)));
  act(() => b.dispatchEvent(ptr('pointermove', toX * SCALE, toY * SCALE)));
  act(() => b.dispatchEvent(ptr('pointerup', toX * SCALE, toY * SCALE)));
}

describe('autosave + undo-history persistence across reload (criterion 3)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('a reload restores the track AND a working undo history (two undos walk back)', () => {
    const restore = mockCanvasRect();
    try {
      const view = renderToyTable();
      let canvas = getCanvas();
      load(CHAIN);
      const original = committed(canvas);
      moveB(canvas, 500, 300, 700, 120); // edit 1
      const afterEdit1 = committed(canvas);
      moveB(canvas, poseOf(canvas, 'B').x, poseOf(canvas, 'B').y, 250, 120); // edit 2
      const afterEdit2 = committed(canvas);
      expect(undoDepth()).toBe(2);

      // RELOAD: unmount + remount, reading the SAME localStorage (not cleared).
      view.unmount();
      renderToyTable();
      canvas = getCanvas();

      // The track is restored WITHOUT an explicit load…
      expect(committed(canvas)).toEqual(afterEdit2);
      // …and the undo history came back (criterion 4: autosave reload → non-empty).
      expect(undoDepth()).toBe(2);

      // Undo walks back through the RESTORED history, edit-by-edit.
      pressCmdZ();
      expect(committed(canvas)).toEqual(afterEdit1);
      expect(undoDepth()).toBe(1);
      pressCmdZ();
      expect(committed(canvas)).toEqual(original);
      expect(undoDepth()).toBe(0);
    } finally {
      restore();
    }
  });
});

describe('named-slot save/load (criteria 2, 5) + load-vs-undo semantics (criterion 4)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('save → the slot appears → load after a different build returns the track → delete removes it', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(CHAIN);
      const chainCommitted = committed(canvas);

      // Name + save the current track.
      const input = screen.getByTestId('save-name-input') as HTMLInputElement;
      act(() => fireEvent.change(input, { target: { value: 'oval' } }));
      act(() => screen.getByTestId('save-slot-button').dispatchEvent(ptr('click', 0, 0)));
      expect(screen.getByTestId('slot-oval')).toBeTruthy();

      // Build something different, then load the slot back.
      load(SINGLE);
      expect(ids(canvas)).toEqual(['X']);
      act(() => screen.getByTestId('load-slot-oval').dispatchEvent(ptr('click', 0, 0)));
      expect(committed(canvas)).toEqual(chainCommitted);

      // Delete removes the slot from the list.
      act(() => screen.getByTestId('delete-slot-oval').dispatchEvent(ptr('click', 0, 0)));
      expect(screen.queryByTestId('slot-oval')).toBeNull();
    } finally {
      restore();
    }
  });

  it('a named-slot load CLEARS the live undo stack (no cross-layout undo)', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(CHAIN);
      const input = screen.getByTestId('save-name-input') as HTMLInputElement;
      act(() => fireEvent.change(input, { target: { value: 'base' } }));
      act(() => screen.getByTestId('save-slot-button').dispatchEvent(ptr('click', 0, 0)));

      // Accumulate undo history, then load a slot — the stack must reset to empty.
      moveB(canvas, 500, 300, 700, 120);
      moveB(canvas, poseOf(canvas, 'B').x, poseOf(canvas, 'B').y, 250, 120);
      expect(undoDepth()).toBe(2);
      act(() => screen.getByTestId('load-slot-base').dispatchEvent(ptr('click', 0, 0)));
      expect(undoDepth()).toBe(0);
      // Cmd+Z after a slot-load is a safe no-op (nothing to undo into).
      pressCmdZ();
      expect(undoDepth()).toBe(0);
    } finally {
      restore();
    }
  });

  it('the Save button is disabled for a blank name', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      expect((screen.getByTestId('save-slot-button') as HTMLButtonElement).disabled).toBe(true);
      const input = screen.getByTestId('save-name-input') as HTMLInputElement;
      act(() => fireEvent.change(input, { target: { value: 'x' } }));
      expect((screen.getByTestId('save-slot-button') as HTMLButtonElement).disabled).toBe(false);
    } finally {
      restore();
    }
  });
});
