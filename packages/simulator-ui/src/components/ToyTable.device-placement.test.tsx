import { act, render, screen } from '@testing-library/react';
/**
 * Device-placement fix (goal item 1). A device piece (train/carriage/gate) is not
 * a rail segment, so MOVING one must NOT run through the track endpoint-pairing
 * snapper (`placeFromCursor`/`computeMovePlacement`) — that flings it to a
 * neighbour's open end (the operator's "snaps to a seemingly random place") and
 * leaves it mis-oriented until it happens to sit on track. A moved device should
 * land where it is dropped and (for a train) adopt the nearest rail's heading —
 * exactly as fresh tray placement already does.
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;
const SCALE = 2;

/* Straights are 200mm long, so they chain cleanly at 200mm spacing (endpoints
 * coincide). C is then a genuine MIDDLE marker with edges both east (→D) and
 * west (→B). The train starts on B facing EAST (0°); moving it to C must keep it
 * facing east — not flip 180° to whatever the deterministic edge sort picks. */
const TRACK_AND_TRAIN: ReadonlyArray<TrackPiece> = [
  { id: 'A', type: 'straight', position: { x: 200, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'B', type: 'straight', position: { x: 400, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'C', type: 'straight', position: { x: 600, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'D', type: 'straight', position: { x: 800, y: 300 }, rotationDeg: 0, tagged: false },
  { id: 'T', type: 'train', position: { x: 400, y: 300 }, rotationDeg: 0, tagged: false },
];

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-device-place');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-device-place" />
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

describe('device placement — a moved device snaps to the rail, not a track endpoint', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('moving a train keeps its heading — it does not flip 180° to an arbitrary rail leg', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(TRACK_AND_TRAIN));
      expect(poseOf(canvas, 'T').deg).toBeCloseTo(0, 0); // starts facing east

      const t = canvas.querySelector('[data-piece-id="T"]');
      if (t === null) throw new Error('train T not rendered');

      /* Move the train from B (400,300) to the middle marker C (600,300) — where
         BOTH rail directions exist, so the chosen heading is a real choice. */
      act(() => t.dispatchEvent(ptr('pointerdown', 400 * SCALE, 300 * SCALE)));
      act(() => t.dispatchEvent(ptr('pointermove', 600 * SCALE, 300 * SCALE)));
      act(() => t.dispatchEvent(ptr('pointerup', 600 * SCALE, 300 * SCALE)));

      const pose = poseOf(canvas, 'T');
      /* Followed the drag onto the rail near C. */
      expect(
        Math.hypot(pose.x - 600, pose.y - 300),
        `train landed at (${pose.x},${pose.y}), not near C (600,300)`,
      ).toBeLessThan(60);
      /* STILL faces east (~0°) — the bug flipped it to ~180°. */
      const off = ((pose.deg % 360) + 360) % 360;
      expect(
        Math.min(off, 360 - off),
        `train heading ${pose.deg}° — it should stay facing east (0°), not flip 180°`,
      ).toBeLessThan(20);
    } finally {
      restore();
    }
  });
});
