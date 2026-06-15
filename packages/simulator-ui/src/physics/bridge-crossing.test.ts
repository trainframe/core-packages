import { describe, expect, it } from 'vitest';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';

const S: PieceSpec = { type: 'straight' };
const RAMP: PieceSpec = { type: 'ramp' };
/** A down-ramp: attached by its HIGH end, so the rail descends back to the ground. */
const RAMP_DOWN: PieceSpec = { type: 'ramp', connectVia: 1 };

describe('bridge crossing — one run carried OVER another on a height layer', () => {
  it('allows a cross-layer crossing (a bridge) that a same-layer overlap would reject', () => {
    const b = new PieceNetworkBuilder();
    b.run('ground', { x: 0, y: 0, dir: 0, layer: 0 }, [S, S, S, S]); // east along y = 0
    /* The over-track approaches from the south, ramps UP to layer 1, crosses the
     *  ground track on a layer-1 straight, then ramps back DOWN — a bridge. */
    const exit = b.run('over', { x: 400, y: 500, dir: 270, layer: 0 } as Cursor, [
      S,
      RAMP,
      S, // the layer-1 span passing over the ground track
      RAMP_DOWN,
      S,
    ]);
    expect(() => b.build()).not.toThrow(); // the two tracks share (x,y) but not a layer
    expect(exit.layer).toBe(0); // the ramps balance — back on the ground
  });

  it('still rejects a genuine SAME-layer overlap (no accidental bridge)', () => {
    const b = new PieceNetworkBuilder();
    b.run('ground', { x: 0, y: 0, dir: 0, layer: 0 }, [S, S, S, S]);
    /* The same crossing but FLAT (no ramps) — the over-track stays on layer 0 and a
     *  piece body fouls the ground track mid-span. */
    b.run('flat', { x: 300, y: 300, dir: 270, layer: 0 } as Cursor, [S, S, S]);
    expect(() => b.build()).toThrow(/crosses over itself/);
  });
});
