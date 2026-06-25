import { act, render, screen } from '@testing-library/react';
/**
 * Reproduction (goal A, criteria 1 & 3): place a chain → flex it → add a new
 * piece — and assert NO piece vanishes (count preserved, every pose finite and
 * on-canvas). Checks after EACH step to localise whether the loss is introduced
 * by the flex/bake or by the subsequent add.
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { type TrackPiece, getEndpoints } from '@trainframe/simulator/track/pieces.js';
import { computePlacement } from '@trainframe/simulator/track/placement.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const CANVAS_W = 900;
const CANVAS_H = 600;
const SCALE = 2;

/* Four straights chained end-to-end (centres 200mm apart = the straight length),
   left→right, all within the canvas. */
const CHAIN: ReadonlyArray<TrackPiece> = [0, 1, 2, 3].map((i) => ({
  id: `P${i}`,
  type: 'straight',
  position: { x: 150 + i * 200, y: 300 },
  rotationDeg: 0,
  tagged: false,
}));

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-vanish');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-vanish" />
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

function ptr(type: string, xPx: number, yPx: number): Event {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: xPx,
    clientY: yPx,
  });
}

/* A chain of `n` curves snapped end-to-end via the real placement path — the
   same connected open arc the flex property test builds. Off-grid rotations
   accumulate down the line, so flexing it bends real angles (unlike straights). */
function curveChain(n: number): TrackPiece[] {
  const pieces: TrackPiece[] = [];
  const first = computePlacement(450, 300, 'curve', pieces);
  pieces.push({
    id: 'c0',
    type: 'curve',
    position: { x: first.x, y: first.y },
    rotationDeg: first.rotationDeg,
    tagged: false,
  });
  for (let i = 1; i < n; i++) {
    const prev = pieces[i - 1];
    if (prev === undefined) throw new Error('unreachable');
    const exit = getEndpoints(prev)[1];
    if (exit === undefined) throw new Error('unreachable');
    const p = computePlacement(exit.x, exit.y, 'curve', pieces);
    pieces.push({
      id: `c${i}`,
      type: 'curve',
      position: { x: p.x, y: p.y },
      rotationDeg: p.rotationDeg,
      tagged: false,
    });
  }
  return pieces;
}

interface Pose {
  id: string;
  x: number;
  y: number;
  deg: number;
}

function poses(canvas: Element): Pose[] {
  return [...canvas.querySelectorAll('[data-piece-id]')].map((el) => {
    const t = el.getAttribute('transform') ?? '';
    const tr = /translate\(([-\d.eE]+),?\s*([-\d.eE]+)\)/.exec(t);
    const ro = /rotate\(([-\d.eE]+)/.exec(t);
    return {
      id: el.getAttribute('data-piece-id') ?? '',
      x: tr ? Number.parseFloat(tr[1] ?? 'NaN') : Number.NaN,
      y: tr ? Number.parseFloat(tr[2] ?? 'NaN') : Number.NaN,
      deg: ro ? Number.parseFloat(ro[1] ?? 'NaN') : Number.NaN,
    };
  });
}

/** Every rendered piece must be present, finite, and roughly on-canvas. */
function assertNoVanish(canvas: Element, expectedIds: ReadonlyArray<string>, where: string): void {
  const ps = poses(canvas);
  const ids = ps.map((p) => p.id).sort();
  expect(ids, `${where}: piece set`).toEqual([...expectedIds].sort());
  for (const p of ps) {
    expect(
      Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.deg),
      `${where}: ${p.id} finite (${p.x},${p.y},${p.deg})`,
    ).toBe(true);
    // Generous on-canvas bound (off-canvas/NaN ⇒ vanished from view).
    expect(p.x > -400 && p.x < CANVAS_W + 400, `${where}: ${p.id} x on-canvas (${p.x})`).toBe(true);
    expect(p.y > -400 && p.y < CANVAS_H + 400, `${where}: ${p.id} y on-canvas (${p.y})`).toBe(true);
  }
}

describe('flex then add a piece — no piece vanishes (criterion 1/3)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('flexing a chain then adding a piece keeps every piece present + finite + on-canvas', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(CHAIN));
      assertNoVanish(canvas, ['P0', 'P1', 'P2', 'P3'], 'after load');

      // Flex the free END piece (P3 at x=750): hold past the dwell, drag down, release.
      const end = canvas.querySelector('[data-piece-id="P3"]');
      if (end === null) throw new Error('P3 not rendered');
      act(() => end.dispatchEvent(ptr('pointerdown', 750 * SCALE, 300 * SCALE)));
      act(() => vi.advanceTimersByTime(300));
      act(() => end.dispatchEvent(ptr('pointermove', 750 * SCALE, 360 * SCALE)));
      act(() => end.dispatchEvent(ptr('pointerup', 750 * SCALE, 360 * SCALE)));
      assertNoVanish(canvas, ['P0', 'P1', 'P2', 'P3'], 'after flex');

      // Add a NEW piece: arm a straight from the toybox, click the canvas in open space.
      act(() => screen.getByTestId('toybox-straight').dispatchEvent(ptr('pointerdown', 5, 5)));
      act(() => window.dispatchEvent(ptr('pointermove', 300 * SCALE, 480 * SCALE)));
      act(() => window.dispatchEvent(ptr('pointerup', 300 * SCALE, 480 * SCALE)));
      const ids = [...canvas.querySelectorAll('[data-piece-id]')].map((el) =>
        el.getAttribute('data-piece-id'),
      );
      expect(ids, 'a new piece was added').toHaveLength(5);
      const newId = ids.find((id) => id !== null && !['P0', 'P1', 'P2', 'P3'].includes(id));
      if (!newId) throw new Error('new piece id not found');
      assertNoVanish(canvas, ['P0', 'P1', 'P2', 'P3', newId], 'after add');
    } finally {
      restore();
    }
  });

  it('flexing a MIDDLE piece (anchor + far pieces on opposite sides) then adding keeps all pieces', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(CHAIN));

      // Flex a MIDDLE piece (P1): the anchor is one far end, P2/P3 lie beyond it.
      const mid = canvas.querySelector('[data-piece-id="P1"]');
      if (mid === null) throw new Error('P1 not rendered');
      act(() => mid.dispatchEvent(ptr('pointerdown', 350 * SCALE, 300 * SCALE)));
      act(() => vi.advanceTimersByTime(300));
      act(() => mid.dispatchEvent(ptr('pointermove', 350 * SCALE, 350 * SCALE)));
      act(() => mid.dispatchEvent(ptr('pointerup', 350 * SCALE, 350 * SCALE)));
      assertNoVanish(canvas, ['P0', 'P1', 'P2', 'P3'], 'after mid-flex');

      act(() => screen.getByTestId('toybox-straight').dispatchEvent(ptr('pointerdown', 5, 5)));
      act(() => window.dispatchEvent(ptr('pointermove', 200 * SCALE, 500 * SCALE)));
      act(() => window.dispatchEvent(ptr('pointerup', 200 * SCALE, 500 * SCALE)));
      expect([...canvas.querySelectorAll('[data-piece-id]')]).toHaveLength(5);
      const ps = poses(canvas);
      for (const p of ps) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y), `mid-flex add: ${p.id} finite`).toBe(
          true,
        );
      }
    } finally {
      restore();
    }
  });

  it('RE-flexing the same chain twice then adding keeps all pieces finite', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(CHAIN));
      const end = canvas.querySelector('[data-piece-id="P3"]');
      if (end === null) throw new Error('P3 not rendered');
      const flex = (toY: number): void => {
        const p = poses(canvas).find((q) => q.id === 'P3');
        act(() =>
          end.dispatchEvent(ptr('pointerdown', (p?.x ?? 750) * SCALE, (p?.y ?? 300) * SCALE)),
        );
        act(() => vi.advanceTimersByTime(300));
        act(() => end.dispatchEvent(ptr('pointermove', 750 * SCALE, toY * SCALE)));
        act(() => end.dispatchEvent(ptr('pointerup', 750 * SCALE, toY * SCALE)));
      };
      flex(355);
      flex(250); // re-flex the other way
      flex(360);
      assertNoVanish(canvas, ['P0', 'P1', 'P2', 'P3'], 'after re-flex');
      act(() => screen.getByTestId('toybox-straight').dispatchEvent(ptr('pointerdown', 5, 5)));
      act(() => window.dispatchEvent(ptr('pointermove', 300 * SCALE, 500 * SCALE)));
      act(() => window.dispatchEvent(ptr('pointerup', 300 * SCALE, 500 * SCALE)));
      expect([...canvas.querySelectorAll('[data-piece-id]')]).toHaveLength(5);
      for (const p of poses(canvas)) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y), `re-flex add: ${p.id} finite`).toBe(
          true,
        );
      }
    } finally {
      restore();
    }
  });

  it('CURVE arc: flex+bake the end, then DROP a curve onto the baked off-grid end — no piece vanishes', () => {
    vi.useFakeTimers();
    const restore = mockCanvasRect();
    try {
      const arc = curveChain(6);
      const restIds = arc.map((p) => p.id);
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(arc));
      assertNoVanish(canvas, restIds, 'curve after load');

      // Flex+bake the free END curve (last placed). Drag its rendered centre.
      const endId = `c${arc.length - 1}`;
      const end = canvas.querySelector(`[data-piece-id="${endId}"]`);
      if (end === null) throw new Error(`${endId} not rendered`);
      const ep = poses(canvas).find((p) => p.id === endId);
      if (ep === undefined) throw new Error('end pose missing');
      act(() => end.dispatchEvent(ptr('pointerdown', ep.x * SCALE, ep.y * SCALE)));
      act(() => vi.advanceTimersByTime(300));
      act(() => end.dispatchEvent(ptr('pointermove', (ep.x + 30) * SCALE, (ep.y + 40) * SCALE)));
      act(() => end.dispatchEvent(ptr('pointerup', (ep.x + 30) * SCALE, (ep.y + 40) * SCALE)));
      assertNoVanish(canvas, restIds, 'curve after flex+bake');

      // ADD a new curve at the baked (off-grid) open end. Uses the exact-placement
      // setup hook: the point under test is that adding a piece after a flex+bake
      // re-renders without vanishing any existing piece — not the pointer gesture,
      // and the baked end can sit off-canvas where the bounds-checked drag won't
      // place. __tfPlacePiece routes through the same placePiece the gesture commits.
      const baked = poses(canvas).find((p) => p.id === endId);
      if (baked === undefined) throw new Error('baked end pose missing');
      act(() => {
        window.__tfPlacePiece?.('curve', baked.x, baked.y);
      });

      const ids = [...canvas.querySelectorAll('[data-piece-id]')].map((el) =>
        el.getAttribute('data-piece-id'),
      );
      expect(ids, 'a curve was added').toHaveLength(arc.length + 1);
      const newId = ids.find((id) => id !== null && !restIds.includes(id));
      if (!newId) throw new Error('new curve id not found');
      assertNoVanish(canvas, [...restIds, newId], 'curve after drop-add');
    } finally {
      restore();
    }
  });
});
