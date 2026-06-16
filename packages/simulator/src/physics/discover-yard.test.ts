import { describe, expect, it } from 'vitest';
import { type Footprint, discoverYardSlots } from './discover-yard.js';
import { buildMainLoopScene } from './interesting-layout.js';

describe('discoverYardSlots — the gantry finds the stabling roads under its footprint', () => {
  it('identifies the parallelogram yard slots (and nothing else) from a footprint over it', () => {
    const scene = buildMainLoopScene();
    const seg = scene.yard; // ParallelogramYardSegments — the real slot ids
    const geom = scene.geom;

    /* The gantry footprint: the bounding box over the yard (with a margin), as if the
     *  operator dropped the gantry over the yard patch. */
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const id of [seg.topLeadIn, seg.bottomLeadOutSeg, ...seg.slots]) {
      const g = geom.get(id);
      if (g === undefined) continue;
      for (const p of [g.start, g.end]) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
    const footprint: Footprint = {
      minX: minX - 30,
      maxX: maxX + 30,
      minY: minY - 30,
      maxY: maxY + 30,
    };

    const found = discoverYardSlots(scene.net.segments(), geom, footprint);

    /* It finds exactly the yard's slot roads — the fan of parallel diagonals — not the
     *  leads, throats, gaps or curves around them. */
    expect([...found].sort()).toEqual([...seg.slots].sort());
  });

  it('stalls (returns nothing) on a footprint with no fan of roads', () => {
    const scene = buildMainLoopScene();
    /* A footprint out on the open running line — a straight or two, no fan of sidings. */
    const found = discoverYardSlots(scene.net.segments(), scene.geom, {
      minX: -100,
      maxX: 100,
      minY: -100,
      maxY: 100,
    });
    expect(found).toEqual([]);
  });
});
