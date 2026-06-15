import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { RAILYARD_MARKERS, railyardToLayout } from './railyard-markers.js';
import { buildFullRailyardScene } from './railyard-pieces.js';

const M = RAILYARD_MARKERS;

/* Marker ids are nominally `uuid`-format in the protocol, but the demo uses
 * readable internal names (M-central, …) — the same convention the bezier scene
 * uses, and operators never see them (they route station → station). Register a
 * permissive `uuid` format so the schema check validates STRUCTURE, not the
 * cosmetic id format. */
FormatRegistry.Set('uuid', () => true);

/** Follow the directed edges from `start`, returning every marker reached. */
function reachable(
  edges: ReturnType<typeof buildFullRailyardScene>['markerLayer']['edges'],
  start: string,
): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const here = queue.shift();
    if (here === undefined) continue;
    for (const e of edges) {
      if (e.from === here && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

describe('railyard markers — the sparse core layer over the real-piece scene', () => {
  it('compiles to a schema-valid protocol Layout', () => {
    const scene = buildFullRailyardScene();
    const layout = railyardToLayout(scene.net, scene.markerLayer, 'railyard');
    expect(Value.Check(Layout, layout)).toBe(true);
  });

  it('places SPARSE markers — two stations, one junction, a yard entry, block boundaries', () => {
    const { markers } = buildFullRailyardScene();
    expect(markers).toHaveLength(7); // not one-per-piece — a handful at decisions/boundaries
    const byKind = (k: string) => markers.filter((m) => m.kind === k).map((m) => m.id);
    expect(byKind('station_stop').sort()).toEqual([M.central, M.north].sort());
    expect(byKind('junction')).toEqual([M.passing]);
    expect(byKind('yard_entry')).toEqual([M.throat]);
    expect(byKind('block_boundary').sort()).toEqual([M.east, M.loop, M.west].sort());
  });

  it('declares the passing loop as the ONLY core junction (the yard throat is the device’s)', () => {
    const { junctions } = buildFullRailyardScene();
    expect(junctions).toHaveLength(1);
    expect(junctions[0]?.markerId).toBe(M.passing);
    expect([...(junctions[0]?.positions ?? [])].sort()).toEqual(['loop', 'main']);
  });

  it('forms a single closed cycle: every marker is reachable from the west boundary and loops back', () => {
    const { markerLayer } = buildFullRailyardScene();
    const seen = reachable(markerLayer.edges, M.west);
    for (const m of markerLayer.markers) expect(seen.has(m.id)).toBe(true);
    /* The cycle returns to the start: some edge points back at M-west. */
    expect(markerLayer.edges.some((e) => e.to === M.west)).toBe(true);
  });

  it('makes the passing loop a diamond: main goes straight, loop goes via the siding, both reach Central', () => {
    const { markerLayer } = buildFullRailyardScene();
    const out = markerLayer.edges.filter((e) => e.from === M.passing);
    /* Two routes out of the turnout, each gated on a distinct switch position. */
    const main = out.find((e) => e.to === M.central);
    const loop = out.find((e) => e.to === M.loop);
    expect(main?.requiresSwitch).toBe('main');
    expect(loop?.requiresSwitch).toBe('loop');
    /* The siding rejoins the main run: M-loop → M-central. */
    expect(markerLayer.edges.some((e) => e.from === M.loop && e.to === M.central)).toBe(true);
  });

  it('keeps the yard opaque: the throat → east edge carries no switch requirement', () => {
    const { markerLayer } = buildFullRailyardScene();
    const throatOut = markerLayer.edges.find((e) => e.from === M.throat && e.to === M.east);
    expect(throatOut).toBeDefined();
    expect(throatOut?.requiresSwitch).toBeUndefined();
  });

  it('anchors every marker to a finite, distinct world position on its rail', () => {
    const scene = buildFullRailyardScene();
    const layout = railyardToLayout(scene.net, scene.markerLayer, 'railyard');
    const seen = new Set<string>();
    for (const m of layout.markers) {
      expect(m.position).toBeDefined();
      const { x_mm, y_mm } = m.position ?? { x_mm: Number.NaN, y_mm: Number.NaN };
      expect(Number.isFinite(x_mm) && Number.isFinite(y_mm)).toBe(true);
      const key = `${x_mm},${y_mm}`;
      expect(seen.has(key)).toBe(false); // no two markers collapse to one point
      seen.add(key);
    }
  });
});
