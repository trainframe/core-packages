import { act, render, screen } from '@testing-library/react';
/**
 * Bug: dragging a track piece from the tray could DELETE an existing placed piece
 * (the operator saw a matching piece vanish). Root cause: the module-level
 * `pieceCounter` starts at 0 and is never seeded past the ids of loaded/restored
 * pieces, so `nextPieceId('curve')` eventually mints `curve-2` — colliding with a
 * loaded `curve-2`; React drops the duplicate-keyed node and the original piece
 * disappears. A newly placed piece MUST get an id distinct from every existing one.
 */
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { ToyTable } from './ToyTable.js';

const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;
const SCALE = 2;

/* A loaded layout that already uses a low-numbered id (`curve-2`) — exactly the
 * shape `test-track-layout.json` has. */
const LOADED: ReadonlyArray<TrackPiece> = [
  {
    id: 'straight-1',
    type: 'straight',
    position: { x: 200, y: 300 },
    rotationDeg: 0,
    tagged: false,
  },
  { id: 'curve-2', type: 'curve', position: { x: 400, y: 300 }, rotationDeg: 0, tagged: false },
];

function renderToyTable(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-idcollision');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-idcollision" />
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

function pieceIds(canvas: Element): string[] {
  return [...canvas.querySelectorAll('[data-piece-id]')].map(
    (el) => el.getAttribute('data-piece-id') ?? '',
  );
}

describe('placing a piece never collides with an existing id (no vanish)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('placing curves after loading curve-2 keeps curve-2 and assigns distinct ids', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      act(() => window.__tfLoadPieces?.(LOADED));
      expect(pieceIds(canvas)).toContain('curve-2');

      // Place two curves the way the tray drag commits them (via the exact-place
      // DEV hook → placePiece → nextPieceId). The 2nd would mint `curve-2`.
      act(() => window.__tfPlacePiece?.('curve', 250, 120));
      act(() => window.__tfPlacePiece?.('curve', 300, 150));

      const ids = pieceIds(canvas);
      // The loaded curve-2 must SURVIVE, and every id must be unique.
      expect(ids).toContain('curve-2');
      expect(ids.filter((id) => id === 'curve-2')).toHaveLength(1);
      expect(new Set(ids).size, `ids collided: ${ids.join(', ')}`).toBe(ids.length);
      expect(ids).toHaveLength(4); // straight-1, curve-2, + two new curves
    } finally {
      restore();
    }
  });
});
