import { act, render, screen } from '@testing-library/react';
/**
 * Authoritative-connection regression (goal criterion 1).
 *
 * Replays the REAL failing session: the on-grid 7-curve open chain from
 * videos/session-log.jsonl, slow-dragging its open end (curve-8) toward a cursor
 * it cannot physically reach. The operator was moving slowly (measured 0.1-0.3
 * px/ms; the velocity detach gate is 1.5 px/ms), yet curve-8 severed from the
 * chain and was left loose at the cursor. This drives the component's REAL drag
 * path (no mocks) and asserts the held piece stays seated and connected.
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { FLEX_BUDGET_DEG } from '@trainframe/simulator/track/flex.js';
import { buildJoints, connectedComponents } from '@trainframe/simulator/track/loops.js';
import { type TrackPiece, getEndpointsAt } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;
const SCALE = 2; // client px per mm under the mocked canvas rect

/* The 7 curves at the t=45s rest frame (on the 45-degree grid); curve-5 and
   curve-8 are the two open ends with the 180-degree slot between them empty. */
const SEVEN_CURVE_CHAIN: ReadonlyArray<TrackPiece> = [
  {
    id: 'curve-1',
    type: 'curve',
    position: { x: 372.8785357737105, y: 121.9178972545757 },
    rotationDeg: 0,
    tagged: false,
  },
  {
    id: 'curve-3',
    type: 'curve',
    position: { x: 481.1177558029499, y: 230.15711728381513 },
    rotationDeg: 45,
    tagged: false,
  },
  {
    id: 'curve-4',
    type: 'curve',
    position: { x: 481.11775580294983, y: 383.23049022985106 },
    rotationDeg: 90,
    tagged: false,
  },
  {
    id: 'curve-5',
    type: 'curve',
    position: { x: 372.8785357737104, y: 491.46971025909045 },
    rotationDeg: 135,
    tagged: false,
  },
  {
    id: 'curve-6',
    type: 'curve',
    position: { x: 219.8051628276746, y: 121.9178972545757 },
    rotationDeg: 315,
    tagged: false,
  },
  {
    id: 'curve-7',
    type: 'curve',
    position: { x: 111.56594279843522, y: 230.15711728381513 },
    rotationDeg: 270,
    tagged: false,
  },
  {
    id: 'curve-8',
    type: 'curve',
    position: { x: 111.56594279843522, y: 383.23049022985106 },
    rotationDeg: 225,
    tagged: false,
  },
];

/* The logged cursor path (world mm) for the t=45 slow drag of curve-8. */
const PATH_MM: ReadonlyArray<[number, number]> = [
  [106.9, 386.7],
  [101.3, 385.1],
  [89.3, 382.9],
  [76.8, 378.9],
  [66.7, 375.1],
  [50.9, 368.6],
  [35.8, 363.9],
  [15.6, 353.4],
  [-0.3, 343.7],
  [-5.8, 340.3],
  [-13.1, 337.3],
  [-22.3, 333.3],
  [-33.4, 327.8],
  [-36.4, 318.7],
  [-36.5, 299.5],
  [-36.5, 284],
  [-28.4, 255.4],
  [-15.9, 241.4],
  [-4.9, 234.5],
  [3.4, 227.9],
  [9.8, 218.4],
  [17.4, 208.4],
  [26.7, 202.7],
  [33, 200.2],
  [32.3, 204.7],
  [18.3, 232.7],
  [15.7, 252.3],
  [13.7, 273.5],
  [7.6, 314.2],
  [-7.9, 377.2],
  [-12.5, 385],
  [-13.6, 385],
  [-4.6, 390.7],
  [-0.1, 396.7],
  [0.3, 399.6],
];

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-connection');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-connection" />
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

/* A pointer event with an explicit timeStamp so the velocity gate is exercised
   deterministically (slow drag ⇒ large dt per small move ⇒ speed well under gate). */
function pointerEvent(type: string, xPx: number, yPx: number, t: number): Event {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: xPx,
    clientY: yPx,
  });
  Object.defineProperty(e, 'timeStamp', { value: t, configurable: true });
  return e;
}

function poseFromEl(el: Element): { x: number; y: number; rotationDeg: number } {
  const t = el.getAttribute('transform') ?? '';
  const tr = /translate\(([-\d.]+),?\s*([-\d.]+)\)/.exec(t);
  const ro = /rotate\(([-\d.]+)/.exec(t);
  return {
    x: tr ? Number.parseFloat(tr[1] ?? '0') : 0,
    y: tr ? Number.parseFloat(tr[2] ?? '0') : 0,
    rotationDeg: ro ? Number.parseFloat(ro[1] ?? '0') : 0,
  };
}

/* Read every committed piece back from the DOM as a TrackPiece (rest/baked pose). */
function committedPieces(canvas: Element): TrackPiece[] {
  return [...canvas.querySelectorAll('[data-piece-id]')].map((el) => {
    const pose = poseFromEl(el);
    return {
      id: el.getAttribute('data-piece-id') ?? '',
      type: 'curve',
      position: { x: pose.x, y: pose.y },
      rotationDeg: pose.rotationDeg,
      tagged: false,
    };
  });
}

/* The largest off-45°-grid deviation across all joints (a baked joint's bend). */
function maxJointDeviation(pieces: ReadonlyArray<TrackPiece>): number {
  let max = 0;
  for (const j of buildJoints(pieces)) {
    const a = pieces.find((p) => p.id === j.a.pieceId);
    const b = pieces.find((p) => p.id === j.b.pieceId);
    if (a === undefined || b === undefined) continue;
    const rel = b.rotationDeg - a.rotationDeg;
    max = Math.max(max, Math.abs(rel - Math.round(rel / 45) * 45));
  }
  return max;
}

/* Closest gap between any endpoint of two pieces (how seated their rails are). */
function closestEndpointGap(p1: TrackPiece, p2: TrackPiece): number {
  const e1 = getEndpointsAt(p1, {
    x: p1.position.x,
    y: p1.position.y,
    rotationDeg: p1.rotationDeg,
  });
  const e2 = getEndpointsAt(p2, {
    x: p2.position.x,
    y: p2.position.y,
    rotationDeg: p2.rotationDeg,
  });
  let min = Number.POSITIVE_INFINITY;
  for (const a of e1) for (const b of e2) min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y));
  return min;
}

/* Press + hold still past the flex dwell to enter FLEX mode (fake timers fire the
   hold without real waiting). Caller dispatches the flex moves, then must call
   vi.useRealTimers(). */
function pressAndHoldToFlex(el: Element, xPx: number, yPx: number): void {
  vi.useFakeTimers();
  act(() => {
    el.dispatchEvent(pointerEvent('pointerdown', xPx, yPx, 0));
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe('authoritative connection — real-session regression (criterion 1)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('FLEX-dragging curve-8 (hold) past flex reach keeps the chain ONE connected component', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      act(() => {
        window.__tfLoadPieces?.(SEVEN_CURVE_CHAIN);
      });
      expect(canvas.querySelectorAll('[data-piece-id]')).toHaveLength(7);

      const c8 = canvas.querySelector('[data-piece-id="curve-8"]');
      if (c8 === null) throw new Error('curve-8 not rendered');

      /* Hold to enter flex mode, then drag the open end far (the logged path). */
      pressAndHoldToFlex(c8, 111.56 * SCALE, 383.23 * SCALE);
      let t = 300;
      for (const [mx, my] of PATH_MM) {
        t += 200;
        act(() => {
          c8.dispatchEvent(pointerEvent('pointermove', mx * SCALE, my * SCALE, t));
        });
      }
      const last = PATH_MM[PATH_MM.length - 1] as [number, number];
      act(() => {
        c8.dispatchEvent(pointerEvent('pointerup', last[0] * SCALE, last[1] * SCALE, t + 200));
      });
      vi.useRealTimers();

      const pieces = committedPieces(canvas);

      /* Invariant: the chain never severed — still one assembly. */
      expect(connectedComponents(pieces).length).toBe(1);

      /* Every joint stays within the flex budget (no over-bend baked in). */
      expect(maxJointDeviation(pieces)).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 0.5);

      /* curve-8 stays seated against curve-7 (rails within snap distance). */
      const c7p = pieces.find((p) => p.id === 'curve-7');
      const c8p = pieces.find((p) => p.id === 'curve-8');
      if (c7p === undefined || c8p === undefined) throw new Error('chain piece missing');
      expect(closestEndpointGap(c7p, c8p)).toBeLessThan(30);
    } finally {
      restore();
    }
  });

  it('REPEATED drags of the chain never accumulate over-budget bend or sever it', () => {
    /* The adversary's finding: a fix that bounds the bend WITHIN one drag can still
       compound ACROSS drags if each release bakes the flexed pose back as the next
       drag's rest baseline. Re-drag the chain several times (grab curve-8 at its
       CURRENT pose each time, like an operator nudging the loop shut) and assert
       the authoritative invariant holds after EVERY release: one component, every
       joint within the flex budget from the 45° grid. */
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(SEVEN_CURVE_CHAIN));
      expect(canvas.querySelectorAll('[data-piece-id]')).toHaveLength(7);

      vi.useFakeTimers();
      let t = 0;
      for (let cycle = 0; cycle < 5; cycle++) {
        const c8 = canvas.querySelector('[data-piece-id="curve-8"]');
        if (c8 === null) throw new Error('curve-8 not rendered');
        /* Grab curve-8 at its current rendered origin, HOLD to flex, pull ~50mm. */
        const here = poseFromEl(c8);
        const tgt = [here.x + 30, here.y - 40] as const;
        t += 200;
        act(() => c8.dispatchEvent(pointerEvent('pointerdown', here.x * SCALE, here.y * SCALE, t)));
        act(() => vi.advanceTimersByTime(300)); // hold → flex mode
        for (let k = 1; k <= 4; k++) {
          t += 200;
          const mx = here.x + ((tgt[0] - here.x) * k) / 4;
          const my = here.y + ((tgt[1] - here.y) * k) / 4;
          act(() => c8.dispatchEvent(pointerEvent('pointermove', mx * SCALE, my * SCALE, t)));
        }
        t += 200;
        act(() => c8.dispatchEvent(pointerEvent('pointerup', tgt[0] * SCALE, tgt[1] * SCALE, t)));

        const pieces = committedPieces(canvas);
        expect(connectedComponents(pieces).length, `cycle ${cycle}: chain severed`).toBe(1);
        expect(maxJointDeviation(pieces), `cycle ${cycle}: joint over-bent`).toBeLessThanOrEqual(
          FLEX_BUDGET_DEG + 0.5,
        );
      }
      vi.useRealTimers();
    } finally {
      restore();
    }
  });
});
