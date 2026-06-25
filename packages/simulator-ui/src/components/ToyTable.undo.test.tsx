import { act, render, screen } from '@testing-library/react';
/**
 * Track-edit UNDO (goal criteria 1 & 2).
 *
 * Every committed edit (place, move/reposition, attach, detach, flex-pose bake,
 * delete, rotate, flip) snapshots the committed track state BEFORE mutating it,
 * onto a bounded stack. An Undo button (`data-testid="undo-button"`) and a
 * Cmd/Ctrl+Z hotkey each revert the last operation to the EXACT prior state. The
 * `__tfUndoDepth()` DEV hook reports the stack depth so we can assert an op pushed
 * exactly one entry and undo popped it (the op engaged, not vacuously).
 *
 * Driven through the real rendered component — no mocking of the edit handlers.
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

/* Two straights chained end-to-end: A east end at (400,300) meets B west end. */
const TWO_STRAIGHT_CHAIN: ReadonlyArray<TrackPiece> = [
  { id: 'A', type: 'straight', position: { x: 300, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'B', type: 'straight', position: { x: 500, y: 300 }, rotationDeg: 0, tagged: false },
];

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-undo');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-undo" />
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

/** The committed pose set, read back from the rendered transforms — what undo
 *  must restore deep-equal. */
function committed(canvas: Element): Array<{ id: string; x: number; y: number; deg: number }> {
  return [...canvas.querySelectorAll('[data-piece-id]')]
    .map((el) => {
      const id = el.getAttribute('data-piece-id') ?? '';
      return { id, ...poseOf(canvas, id) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function ids(canvas: Element): string[] {
  return [...canvas.querySelectorAll('[data-piece-id]')]
    .map((el) => el.getAttribute('data-piece-id') ?? '')
    .sort();
}

function undoDepth(): number {
  return window.__tfUndoDepth?.() ?? -1;
}

function pressCmdZ(meta = true): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', metaKey: meta, ctrlKey: !meta, bubbles: true }),
    );
  });
}

function load(pieces: ReadonlyArray<TrackPiece>): void {
  act(() => window.__tfLoadPieces?.(pieces));
}

function getCanvas(): Element {
  return screen.getByTestId('toy-table-canvas') as unknown as Element;
}

describe('track-edit undo — one entry per op + exact restore (criterion 1)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('PLACE pushes exactly one entry; undo removes the placed piece', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      expect(undoDepth()).toBe(0);
      // Drag a straight from the toybox onto the canvas to place one (the sole
      // placement path now arming is gone).
      act(() => screen.getByTestId('toybox-straight').dispatchEvent(ptr('pointerdown', 5, 5)));
      act(() => window.dispatchEvent(ptr('pointermove', 450 * SCALE, 300 * SCALE)));
      act(() => window.dispatchEvent(ptr('pointerup', 450 * SCALE, 300 * SCALE)));
      expect(ids(canvas)).toHaveLength(1);
      expect(undoDepth()).toBe(1);

      pressCmdZ();
      expect(ids(canvas)).toHaveLength(0); // the placed piece is gone
      expect(undoDepth()).toBe(0);
    } finally {
      restore();
    }
  });

  it('MOVE pushes one entry; undo restores the exact prior poses (deep-equal)', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      expect(undoDepth()).toBe(0);
      const before = committed(canvas);

      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      // Move-drag B far into open space (detach + reposition).
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 720 * SCALE, 120 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 720 * SCALE, 120 * SCALE)));
      expect(undoDepth()).toBe(1);
      expect(committed(canvas)).not.toEqual(before); // it moved

      pressCmdZ();
      expect(committed(canvas)).toEqual(before); // exact prior poses
      expect(undoDepth()).toBe(0);
    } finally {
      restore();
    }
  });

  it('DETACH then ATTACH each push one entry; undo reverses each', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const asPieces = (): TrackPiece[] =>
        committed(canvas).map((p) => ({
          id: p.id,
          type: 'straight' as const,
          position: { x: p.x, y: p.y },
          rotationDeg: p.deg,
          tagged: false,
        }));
      expect(connectedComponents(asPieces()).length).toBe(1);

      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      // DETACH: carry B into empty space.
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 720 * SCALE, 120 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 720 * SCALE, 120 * SCALE)));
      expect(connectedComponents(asPieces()).length).toBe(2); // orphaned
      expect(undoDepth()).toBe(1);

      // ATTACH: carry B back onto A's east end.
      const bNow = poseOf(canvas, 'B');
      act(() => b.dispatchEvent(ptr('pointerdown', bNow.x * SCALE, bNow.y * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 500 * SCALE, 300 * SCALE)));
      expect(connectedComponents(asPieces()).length).toBe(1); // rejoined
      expect(undoDepth()).toBe(2);

      // Undo the attach → detached again.
      pressCmdZ();
      expect(connectedComponents(asPieces()).length).toBe(2);
      expect(undoDepth()).toBe(1);
      // Undo the detach → back to the original chain.
      pressCmdZ();
      expect(connectedComponents(asPieces()).length).toBe(1);
      expect(undoDepth()).toBe(0);
    } finally {
      restore();
    }
  });

  it('FLEX-pose bake pushes one entry; undo returns the chain to its pre-flex poses', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const before = committed(canvas);

      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      // Hold (engage flex), drag (bend), release (BAKE the pose).
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => vi.advanceTimersByTime(300));
      act(() => b.dispatchEvent(ptr('pointermove', 500 * SCALE, 360 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 500 * SCALE, 360 * SCALE)));
      expect(Math.abs(poseOf(canvas, 'B').deg)).toBeGreaterThan(0.5); // posed
      expect(undoDepth()).toBe(1);

      pressCmdZ();
      expect(committed(canvas)).toEqual(before); // pre-flex poses restored
      expect(undoDepth()).toBe(0);
    } finally {
      restore();
    }
  });

  it('ROTATE pushes one entry; undo restores the rotation', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load([TWO_STRAIGHT_CHAIN[0] as TrackPiece]);
      const before = committed(canvas);
      // Select A (click its body), then Rotate via the action button.
      const a = canvas.querySelector('[data-piece-id="A"]');
      if (a === null) throw new Error('A not rendered');
      act(() => a.dispatchEvent(ptr('pointerdown', 300 * SCALE, 300 * SCALE)));
      act(() => a.dispatchEvent(ptr('pointerup', 300 * SCALE, 300 * SCALE)));
      act(() => screen.getByText(/Rotate/).dispatchEvent(ptr('click', 0, 0)));
      expect(poseOf(canvas, 'A').deg).not.toBe(before[0]?.deg);
      expect(undoDepth()).toBe(1);

      pressCmdZ();
      expect(committed(canvas)).toEqual(before);
      expect(undoDepth()).toBe(0);
    } finally {
      restore();
    }
  });

  it('DELETE pushes one entry; undo restores the deleted piece', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const before = committed(canvas);
      // Select B, then Delete via the action button.
      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 500 * SCALE, 300 * SCALE)));
      act(() => screen.getByText(/Delete/).dispatchEvent(ptr('click', 0, 0)));
      expect(ids(canvas)).toEqual(['A']);
      expect(undoDepth()).toBe(1);

      pressCmdZ();
      expect(ids(canvas)).toEqual(['A', 'B']);
      expect(committed(canvas)).toEqual(before);
      expect(undoDepth()).toBe(0);
    } finally {
      restore();
    }
  });

  it('undo on an EMPTY stack is a safe no-op', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const before = committed(canvas);
      expect(undoDepth()).toBe(0);
      pressCmdZ(); // nothing to undo
      expect(undoDepth()).toBe(0);
      expect(committed(canvas)).toEqual(before); // unchanged
    } finally {
      restore();
    }
  });

  it('undo never resurrects a stale/forked state — a new edit replaces the future', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      const move = (toX: number, toY: number): void => {
        act(() =>
          b.dispatchEvent(
            ptr('pointerdown', poseOf(canvas, 'B').x * SCALE, poseOf(canvas, 'B').y * SCALE),
          ),
        );
        act(() => b.dispatchEvent(ptr('pointermove', toX * SCALE, toY * SCALE)));
        act(() => b.dispatchEvent(ptr('pointerup', toX * SCALE, toY * SCALE)));
      };
      move(700, 100); // edit 1
      const afterEdit1 = committed(canvas);
      move(200, 100); // edit 2
      pressCmdZ(); // undo edit 2 → back to afterEdit1
      expect(committed(canvas)).toEqual(afterEdit1);
      move(820, 500); // edit 3 — a NEW branch
      pressCmdZ(); // undo edit 3 → afterEdit1 again, NOT edit 2's forked state
      expect(committed(canvas)).toEqual(afterEdit1);
    } finally {
      restore();
    }
  });
});

describe('undo wiring — button + hotkey (criterion 2)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('the Undo BUTTON reverts the last edit', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const before = committed(canvas);
      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 720 * SCALE, 120 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 720 * SCALE, 120 * SCALE)));
      expect(committed(canvas)).not.toEqual(before);

      const button = screen.getByTestId('undo-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      act(() => button.dispatchEvent(ptr('click', 0, 0)));
      expect(committed(canvas)).toEqual(before);
      expect((screen.getByTestId('undo-button') as HTMLButtonElement).disabled).toBe(true);
    } finally {
      restore();
    }
  });

  it('the Undo button is DISABLED when there is nothing to undo', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      load(TWO_STRAIGHT_CHAIN);
      expect((screen.getByTestId('undo-button') as HTMLButtonElement).disabled).toBe(true);
    } finally {
      restore();
    }
  });

  it('Ctrl+Z (Windows/Linux) also reverts the last edit', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const before = committed(canvas);
      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 720 * SCALE, 120 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 720 * SCALE, 120 * SCALE)));

      pressCmdZ(false); // ctrl, not meta
      expect(committed(canvas)).toEqual(before);
    } finally {
      restore();
    }
  });

  it('an accidental FLEX (hold→drag→release) is recovered by Cmd+Z to the pre-flex poses', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const before = committed(canvas);
      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      // The accidental click-hold that makes the track jump.
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => vi.advanceTimersByTime(300));
      act(() => b.dispatchEvent(ptr('pointermove', 500 * SCALE, 355 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 500 * SCALE, 355 * SCALE)));
      expect(committed(canvas)).not.toEqual(before); // the track jumped

      pressCmdZ();
      expect(committed(canvas)).toEqual(before); // snapped back to where it was
    } finally {
      restore();
    }
  });

  it('an accidental MOVE-drag is recovered by Cmd+Z to the prior poses', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const before = committed(canvas);
      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 700 * SCALE, 150 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 700 * SCALE, 150 * SCALE)));
      expect(committed(canvas)).not.toEqual(before);

      pressCmdZ();
      expect(committed(canvas)).toEqual(before);
    } finally {
      restore();
    }
  });

  it('Cmd+Z while typing in a text field does NOT undo the track', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = getCanvas();
      load(TWO_STRAIGHT_CHAIN);
      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 720 * SCALE, 120 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 720 * SCALE, 120 * SCALE)));
      const moved = committed(canvas);
      expect(undoDepth()).toBe(1);

      // A Cmd+Z dispatched from within a text input must be ignored by the table.
      const input = document.createElement('input');
      document.body.appendChild(input);
      act(() => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }),
        );
      });
      expect(undoDepth()).toBe(1); // untouched
      expect(committed(canvas)).toEqual(moved); // track did not revert
      input.remove();
    } finally {
      restore();
    }
  });
});
