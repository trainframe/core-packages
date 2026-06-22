import { act, render, screen } from '@testing-library/react';
/**
 * Two-mode piece dragging — gesture discrimination (goal criteria 1-3).
 *
 * The drag MODE is chosen by the gesture at the START, never inferred from geometry:
 *   - click + drag (cursor leaves the deadzone before the flex dwell) = MOVE MODE:
 *     the piece detaches and follows the cursor; on release it snaps onto a nearby
 *     aligned open end or drops free.
 *   - click + hold still within the deadzone for ~250ms = FLEX MODE: a blue ripple
 *     fires, then dragging flexes the chain (never severs), springing back on release
 *     unless a loop closed.
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
  client.connect('ws://test-gesture');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-gesture" />
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

function committed(canvas: Element): TrackPiece[] {
  return [...canvas.querySelectorAll('[data-piece-id]')].map((el) => {
    const p = poseOf(canvas, el.getAttribute('data-piece-id') ?? '');
    return {
      id: el.getAttribute('data-piece-id') ?? '',
      type: 'straight' as const,
      position: { x: p.x, y: p.y },
      rotationDeg: p.deg,
      tagged: false,
    };
  });
}

describe('gesture modes — move vs flex chosen by gesture (criterion 1)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('click + drag (immediate movement) = MOVE MODE — the piece detaches and repositions', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(TWO_STRAIGHT_CHAIN));
      expect(connectedComponents(committed(canvas)).length).toBe(1); // chained

      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');

      /* Press on B and IMMEDIATELY move it far into empty space (cursor leaves the
         deadzone before any hold dwell) → move mode → detach + reposition. */
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 720 * SCALE, 120 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 720 * SCALE, 120 * SCALE)));

      /* B detached from A and now sits in open space → two components. */
      expect(connectedComponents(committed(canvas)).length).toBe(2);
      const bPose = poseOf(canvas, 'B');
      expect(Math.hypot(bPose.x - 720, bPose.y - 120)).toBeLessThan(60); // moved to drop point
    } finally {
      restore();
    }
  });

  it('click + hold (no movement, dwell) = FLEX MODE — a blue ripple fires, then dragging flexes and STAYS posed', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(TWO_STRAIGHT_CHAIN));

      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');

      /* Press and HOLD still (within the deadzone) past the flex dwell. */
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => vi.advanceTimersByTime(300));

      /* Flex mode engaged → the blue ripple is mounted. */
      expect(screen.queryByTestId('flex-ripple')).not.toBeNull();

      /* Now dragging flexes the chain (B bends perpendicular), staying connected. */
      act(() => b.dispatchEvent(ptr('pointermove', 500 * SCALE, 360 * SCALE)));
      const flexedDeg = Math.abs(poseOf(canvas, 'B').deg);
      expect(flexedDeg).toBeGreaterThan(0); // flexed
      expect(connectedComponents(committed(canvas)).length).toBe(1); // still connected

      /* Release WITHOUT closing a loop → the bend is BAKED (posable): B stays bent
         where it was flexed, still connected and within the flex budget. */
      act(() => b.dispatchEvent(ptr('pointerup', 500 * SCALE, 360 * SCALE)));
      const posedDeg = Math.abs(poseOf(canvas, 'B').deg);
      expect(posedDeg).toBeGreaterThan(0.5); // stayed posed, did NOT spring back
      expect(posedDeg).toBeLessThanOrEqual(5 + 0.5); // within the flex budget
      expect(connectedComponents(committed(canvas)).length).toBe(1);
    } finally {
      restore();
    }
  });
});

describe('move mode — attach, reposition, orphan rejoin (criteria 2 & 4)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('ATTACH — carrying a separate piece onto an aligned open end joins them', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      /* A's east end is at (400,300); C is a separate straight parked far away. */
      act(() =>
        window.__tfLoadPieces?.([
          {
            id: 'A',
            type: 'straight',
            position: { x: 300, y: 300 },
            rotationDeg: 0,
            tagged: false,
          },
          {
            id: 'C',
            type: 'straight',
            position: { x: 650, y: 120 },
            rotationDeg: 0,
            tagged: false,
          },
        ]),
      );
      expect(connectedComponents(committed(canvas)).length).toBe(2); // separate

      const c = canvas.querySelector('[data-piece-id="C"]');
      if (c === null) throw new Error('C not rendered');
      /* Move-drag C so its WEST end lands on A's EAST end: C centre → (500,300). */
      act(() => c.dispatchEvent(ptr('pointerdown', 650 * SCALE, 120 * SCALE)));
      act(() => c.dispatchEvent(ptr('pointermove', 500 * SCALE, 300 * SCALE)));
      act(() => c.dispatchEvent(ptr('pointerup', 500 * SCALE, 300 * SCALE)));

      /* The carried piece seated onto the open end → one assembly. */
      expect(connectedComponents(committed(canvas)).length).toBe(1);
    } finally {
      restore();
    }
  });

  it('orphan rejoin — detach a chained piece, then carry it back onto an end re-attaches', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(TWO_STRAIGHT_CHAIN));
      expect(connectedComponents(committed(canvas)).length).toBe(1);

      const b = canvas.querySelector('[data-piece-id="B"]');
      if (b === null) throw new Error('B not rendered');

      /* 1) Detach B into open space. */
      act(() => b.dispatchEvent(ptr('pointerdown', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 720 * SCALE, 120 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 720 * SCALE, 120 * SCALE)));
      expect(connectedComponents(committed(canvas)).length).toBe(2); // orphaned

      /* 2) Carry it back onto A's east end (B centre → (500,300)) → re-attaches. */
      const bNow = poseOf(canvas, 'B');
      act(() => b.dispatchEvent(ptr('pointerdown', bNow.x * SCALE, bNow.y * SCALE)));
      act(() => b.dispatchEvent(ptr('pointermove', 500 * SCALE, 300 * SCALE)));
      act(() => b.dispatchEvent(ptr('pointerup', 500 * SCALE, 300 * SCALE)));
      expect(connectedComponents(committed(canvas)).length).toBe(1); // rejoined
    } finally {
      restore();
    }
  });
});
