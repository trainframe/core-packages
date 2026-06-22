import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
/**
 * UN-MOCKED closure tests (goal clause 2c + N1 regression).
 *
 * Unlike ToyTable.flex.test.tsx, this file mocks NOTHING — the real solveClose,
 * detectLoopClosure, newLoopCenterline, findLoops and placement all run against a
 * real uneven stadium oval built through the component's own placement path.
 *
 *  - drop-variant-flush: a LILLABO straight variant dropped (dragged) from the
 *    toybox snaps FLUSH onto a neighbour — proving handleDrop threads the armed
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
const TOYBOX_MIME = 'application/x-trainframe-toybox-type';

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

/* Drop a toybox piece of `type` at client (cx, cy) — dragstart + dragover + drop,
   carrying both coordinates and the dataTransfer stub through jsdom. */
function dropAt(canvas: Element, type: string, cx: number, cy: number): void {
  const store: Record<string, string> = { [TOYBOX_MIME]: type };
  const dt = {
    types: [TOYBOX_MIME],
    getData: (m: string) => store[m] ?? '',
    setData: (m: string, v: string) => {
      store[m] = v;
    },
    effectAllowed: 'copy' as string,
    dropEffect: 'copy' as string,
  };
  act(() => {
    fireEvent.dragStart(screen.getByTestId(`toybox-${type}`), { dataTransfer: dt });
    store[TOYBOX_MIME] = type;
  });
  for (const evtType of ['dragover', 'drop']) {
    act(() => {
      const e = new MouseEvent(evtType, {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
      });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      canvas.dispatchEvent(e);
    });
  }
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

/* Set the armed straight length to `lengthMm` by opening the variant fan and
   picking the chip. Arming toggles, so we first arm a DIFFERENT tile (curve) to
   guarantee straight is not already armed, then arming straight reliably expands
   the fan. The drop path reads the TYPE from the drag MIME and the LENGTH from
   armedStraightLength — so only the length pick matters for a dropped straight. */
async function pickLength(
  user: ReturnType<typeof userEvent.setup>,
  lengthMm: number,
): Promise<void> {
  await user.click(screen.getByTestId('toybox-curve')); // force armedType !== straight
  await user.click(screen.getByTestId('toybox-straight')); // arm + expand the straight fan
  await user.click(screen.getByTestId(`toybox-straight-length-${lengthMm}`)); // sets armedStraightLength
}

describe('UN-MOCKED loop closure — flush variant drop + wave on mouse-up', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
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

      /* Arm a 60mm variant and DROP it on the anchor's east end. */
      await pickLength(user, 60);
      dropAt(canvas, 'straight', anchorEast.x * SCALE, anchorEast.y * SCALE);
      const dropped = pieceFromEl(lastPieceEl(canvas), 'straight');

      /* It carries the 60mm override AND its entry sits flush on the joint —
         which only holds if handleDrop passed lengthMm into placement. */
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
        /* Curves carry their type in the drag MIME — no arming needed. Straights
           need the armed length set so the variant snaps flush. */
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

      /* Slow-drag the last curve so its free endpoint is driven onto the target.
         Same timeStamp across events ⇒ velocity gate reads slow ⇒ the chain
         flexes (no detach). detectLoopClosure runs the REAL solveClose. */
      const ev = (t: string, x: number, y: number, button = 0) =>
        new MouseEvent(t, { bubbles: true, cancelable: true, button, clientX: x, clientY: y });
      act(() => {
        lastEl.dispatchEvent(ev('pointerdown', lastPose.x * SCALE, lastPose.y * SCALE));
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
      expect(screen.queryByTestId('closure-wave')).not.toBeNull();
    } finally {
      restore();
    }
  });
});
