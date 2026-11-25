import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
/**
 * UN-MOCKED closure tests (goal clause 2c + N1 regression).
 *
 * Unlike ToyTable.flex.test.tsx, this file mocks NOTHING — the real solveClose,
 * detectLoopClosure, newLoopCenterline, findLoops and placement all run against a
 * real uneven stadium oval built through the component's own placement path.
 *
 *  - drop-variant-flush: a LILLABO straight variant dropped from the toybox snaps
 *    FLUSH onto a neighbour — proving the snap-place path threads the configured
 *    length into placement (the click path is covered in placement.test.ts).
 *  - wave-fires-on-mouse-up: building a real uneven oval and slow-dragging its open
 *    end to within closure range flashes `data-closure-available`; releasing the
 *    pointer mounts the `closure-wave` element with a real (un-mocked) centreline.
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { type TrackPiece, getEndpoints } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;
const SCALE = 2; // client px per mm under the mocked canvas rect

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-closure-real');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-closure-real" />
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

/* Drop a toybox piece of `type` at client (cx, cy) via the snap-then-place setup
   hook (computePlacement onto a nearby open end → placePiece), threading the
   configured straight length so a variant snaps flush. */
function dropAt(_canvas: Element, type: TrackPiece['type'], cx: number, cy: number): void {
  act(() => {
    window.__tfDropPiece?.(type, cx / SCALE, cy / SCALE);
  });
}

/* Parse `translate(x, y) rotate(deg) ...` from a piece group's transform. */
function parsePose(el: Element): { x: number; y: number; rotationDeg: number } {
  const t = el.getAttribute('transform') ?? '';
  const tr = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(t);
  const ro = /rotate\(([-\d.]+)\)/.exec(t);
  return {
    x: tr ? Number.parseFloat(tr[1] ?? '0') : 0,
    y: tr ? Number.parseFloat(tr[2] ?? '0') : 0,
    rotationDeg: ro ? Number.parseFloat(ro[1] ?? '0') : 0,
  };
}

/* The last placed piece element (most recent in DOM order). */
function lastPieceEl(canvas: Element): Element {
  const all = canvas.querySelectorAll('[data-piece-id]');
  const el = all[all.length - 1];
  if (el === undefined) throw new Error('no placed piece');
  return el;
}

/* Client (px) coords to drop the next chained piece: the previous piece's exit
   endpoint (× SCALE), or a fixed seed point when the canvas is empty. */
function nextDropClient(canvas: Element, seedMm: number): [number, number] {
  const all = canvas.querySelectorAll('[data-piece-id]');
  const prevEl = all[all.length - 1];
  if (prevEl === undefined) return [seedMm * SCALE, seedMm * SCALE];
  const prevType = (prevEl.getAttribute('data-testid') ?? '').includes('curve')
    ? 'curve'
    : 'straight';
  const exit = getEndpoints(pieceFromEl(prevEl, prevType))[1];
  if (exit === undefined) throw new Error('no exit endpoint');
  return [exit.x * SCALE, exit.y * SCALE];
}

/* Reconstruct a TrackPiece from a placed element so we can read its endpoints. */
function pieceFromEl(el: Element, type: TrackPiece['type']): TrackPiece {
  const pose = parsePose(el);
  const lenAttr = el.getAttribute('data-length-mm');
  return {
    id: el.getAttribute('data-piece-id') ?? '',
    type,
    position: { x: pose.x, y: pose.y },
    rotationDeg: pose.rotationDeg,
    tagged: false,
    ...(lenAttr !== null && lenAttr !== '' ? { lengthMm: Number.parseFloat(lenAttr) } : {}),
  };
}

/* Set the configured straight length to `lengthMm` by opening the variant fan
   and picking the chip. The fan toggles open/closed per tile, so we first open a
   DIFFERENT tile's fan (curve) to guarantee straight's fan is closed, then
   tapping straight reliably expands it. The drag drop path reads the TYPE from
   the drag MIME and the LENGTH from the configured straight length — so only the
   length pick matters for a dropped straight. */
async function pickLength(
  user: ReturnType<typeof userEvent.setup>,
  lengthMm: number,
): Promise<void> {
  await user.click(screen.getByTestId('toybox-curve')); // open a different fan to close straight's
  await user.click(screen.getByTestId('toybox-straight')); // expand the straight fan
  await user.click(screen.getByTestId(`toybox-straight-length-${lengthMm}`)); // sets the straight length
}

describe('UN-MOCKED loop closure — flush variant drop + wave on mouse-up', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('drop-variant-flush: a dragged 60mm straight snaps flush onto a neighbour (N1)', async () => {
    const restore = mockCanvasRect();
    try {
      const user = userEvent.setup();
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      /* Anchor: a default 200mm straight at mm (300,300) → client (600,600).
         Its east endpoint is at mm (400,300). */
      await pickLength(user, 200);
      dropAt(canvas, 'straight', 300 * SCALE, 300 * SCALE);
      const anchor = pieceFromEl(lastPieceEl(canvas), 'straight');
      const anchorEast = getEndpoints(anchor)[1];
      if (anchorEast === undefined) throw new Error('no anchor east');

      /* Configure a 60mm variant and DROP it on the anchor's east end. */
      await pickLength(user, 60);
      dropAt(canvas, 'straight', anchorEast.x * SCALE, anchorEast.y * SCALE);
      const dropped = pieceFromEl(lastPieceEl(canvas), 'straight');

      /* It carries the 60mm override AND its entry sits flush on the joint —
         which only holds if the snap-place path passed lengthMm into placement. */
      expect(dropped.lengthMm).toBe(60);
      const droppedWest = getEndpoints(dropped)[0];
      if (droppedWest === undefined) throw new Error('no dropped west');
      const gap = Math.hypot(droppedWest.x - anchorEast.x, droppedWest.y - anchorEast.y);
      expect(gap).toBeLessThan(0.5);
    } finally {
      restore();
    }
  });

  it('wave-fires-on-mouse-up: a real closing drag flashes then mounts the wave', async () => {
    const restore = mockCanvasRect();
    try {
      const user = userEvent.setup();
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      /* Build an uneven stadium oval through the component's real placement path:
         side 150, four curves, side 110, four curves. Each piece is dropped onto
         the previous piece's exit endpoint (read back from the DOM so the test
         stays in lockstep with the component's actual poses). */
      const place = async (type: TrackPiece['type'], lengthMm?: number): Promise<TrackPiece> => {
        const [cx, cy] = nextDropClient(canvas, 300);
        /* Curves need no variant config. Straights need the configured length set
           (via the fan) so the variant snaps flush. */
        if (type === 'straight') await pickLength(user, lengthMm ?? 200);
        dropAt(canvas, type, cx, cy);
        return pieceFromEl(lastPieceEl(canvas), type);
      };

      const first = await place('straight', 150);
      await place('curve');
      await place('curve');
      await place('curve');
      await place('curve');
      await place('straight', 110);
      await place('curve');
      await place('curve');
      await place('curve');
      const lastCurve = await place('curve');

      /* Ten pieces placed, forming a genuine open near-closure (a ~40mm closing
         gap — verified by the geometry-level closure-bakes-cycle test). */
      expect(canvas.querySelectorAll('[data-piece-id]')).toHaveLength(10);

      /* The closure target: the first piece's entry endpoint (open end of the
         near-closed loop). The last curve's free end sits ~40mm from it. */
      const target = getEndpoints(first)[0];
      if (target === undefined) throw new Error('no target');
      const lastEl = canvas.querySelector(`[data-piece-id="${lastCurve.id}"]`);
      if (lastEl === null) throw new Error('last curve gone');
      const lastPose = parsePose(lastEl);

      /* HOLD to enter FLEX mode, then drag the last curve's free endpoint onto the
         target. detectLoopClosure runs the REAL solveClose. (Fake timers fire the
         hold; the async build above already ran on real timers.) */
      const ev = (t: string, x: number, y: number, button = 0) =>
        new MouseEvent(t, { bubbles: true, cancelable: true, button, clientX: x, clientY: y });
      vi.useFakeTimers();
      act(() => {
        lastEl.dispatchEvent(ev('pointerdown', lastPose.x * SCALE, lastPose.y * SCALE));
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      act(() => {
        lastEl.dispatchEvent(ev('pointermove', target.x * SCALE, target.y * SCALE));
      });

      /* The dragged piece flashes closure-available — the REAL detectLoopClosure
         ran the REAL solveClose and reported the loop closeable within budget. */
      const flashing = canvas.querySelector('[data-closure-available="true"]');
      expect(flashing).not.toBeNull();

      /* Release: the loop closes and the wave mounts with a real centreline. */
      act(() => {
        lastEl.dispatchEvent(ev('pointerup', target.x * SCALE, target.y * SCALE));
      });
      vi.useRealTimers();
      expect(screen.queryByTestId('closure-wave')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('a JERKY closing drag (a fast stroke mid-close) still closes — piece not yanked off', async () => {
    /*
     * Regression for the "closure breaks the held piece" report: a real operator's
     * drag is not perfectly smooth. A fast stroke used to trip the velocity gate
     * and YANK the dragged curve off its chain mid-close, so the loop never closed
     * and the operator was left holding a detached piece. The detach now also
     * requires the cursor to be pulled well BEYOND the flex reach (a genuine yank);
     * a fast stroke that still lands the free end on the closure target keeps the
     * piece in the chain and the loop closes.
     */
    const restore = mockCanvasRect();
    try {
      const user = userEvent.setup();
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      const place = async (type: TrackPiece['type'], lengthMm?: number): Promise<TrackPiece> => {
        const [cx, cy] = nextDropClient(canvas, 300);
        if (type === 'straight') await pickLength(user, lengthMm ?? 200);
        dropAt(canvas, type, cx, cy);
        return pieceFromEl(lastPieceEl(canvas), type);
      };
      const first = await place('straight', 150);
      await place('curve');
      await place('curve');
      await place('curve');
      await place('curve');
      await place('straight', 110);
      await place('curve');
      await place('curve');
      await place('curve');
      const lastCurve = await place('curve');
      expect(canvas.querySelectorAll('[data-piece-id]')).toHaveLength(11 - 1);

      const target = getEndpoints(first)[0];
      if (target === undefined) throw new Error('no target');
      const lastEl = canvas.querySelector(`[data-piece-id="${lastCurve.id}"]`);
      if (lastEl === null) throw new Error('last curve gone');
      const lastPose = parsePose(lastEl);

      /* Timed events: a baseline move then a FAST jump straight to the closure
         target (distinct timestamps ⇒ the velocity gate reads a high speed). The
         cursor still lands on the target, so the free end tracks it (small reach
         residual) — the detach must NOT fire. */
      const tev = (t: string, x: number, y: number, ts: number) => {
        const e = new MouseEvent(t, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: x,
          clientY: y,
        });
        Object.defineProperty(e, 'timeStamp', { value: ts, configurable: true });
        return e;
      };
      const sx = lastPose.x * SCALE;
      const sy = lastPose.y * SCALE;
      const tx = target.x * SCALE;
      const ty = target.y * SCALE;
      /* HOLD to enter FLEX mode first, then a faithful jerky drag: a baseline, a
         FAST stroke, then SETTLE onto the target. In flex mode the jerkiness is
         irrelevant — flexing never severs — and the settle closes cleanly. */
      vi.useFakeTimers();
      act(() => {
        lastEl.dispatchEvent(tev('pointerdown', sx, sy, 0));
      });
      act(() => {
        vi.advanceTimersByTime(300); // hold → flex mode
      });
      act(() => {
        lastEl.dispatchEvent(tev('pointermove', sx + 6, sy, 350)); // baseline
      });
      act(() => {
        /* Fast stroke most of the way. */
        lastEl.dispatchEvent(tev('pointermove', sx + (tx - sx) * 0.85, sy + (ty - sy) * 0.85, 362));
      });
      /* Mid-drag, after the fast stroke, the piece must still be on its chain. */
      expect(canvas.querySelectorAll('[data-piece-id]')).toHaveLength(10);
      act(() => {
        /* Settle onto the target. */
        lastEl.dispatchEvent(tev('pointermove', tx, ty, 374));
      });

      /* Not yanked off: the loop is still closeable (flash present); on release the
         wave mounts (the closure committed) and all 10 pieces remain. */
      expect(canvas.querySelector('[data-closure-available="true"]')).not.toBeNull();
      act(() => {
        lastEl.dispatchEvent(tev('pointerup', tx, ty, 386));
      });
      vi.useRealTimers();
      expect(screen.queryByTestId('closure-wave')).not.toBeNull();
      expect(canvas.querySelectorAll('[data-piece-id]')).toHaveLength(10);
    } finally {
      restore();
    }
  });
});
