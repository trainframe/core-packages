/**
 * The railyard interior as a switched rail network (ADR-030 Plan §4). To the
 * physics the yard is ordinary track + junctions: a spine off the throat with two
 * ladder taps, each diverting (when its switch is thrown to `slot`) onto a slot
 * road; the train self-drives it and the yard device throws the points. Core's
 * opaque-zone view (ADR-026/027) is the ONLY thing that treats it specially.
 *
 * Geometry here is deliberately simple (straight spine, straight legs + slots) —
 * enough to drive and render the choreography; the drawn wooden ladder is a
 * separate toy-table concern. World-space mm.
 */
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import type { Rail } from './rail.js';

/** A straight rail segment between two world points (curvature/slope zero). */
export function straightSeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ends: { startBuffered?: boolean; endBuffered?: boolean } = {},
): Rail {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  const headingDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    length,
    at: (d) => {
      const t = length === 0 ? 0 : d / length;
      return { x: ax + dx * t, y: ay + dy * t, headingDeg };
    },
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: ends.startBuffered ?? false,
    endBuffered: ends.endBuffered ?? false,
  };
}

/** A straight segment's world endpoints — for the view to draw a plank along it. */
export interface YardSegGeom {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

export interface YardLayout {
  readonly net: RailNetwork;
  /** Segment id → world endpoints (for rendering the rails as planks). */
  readonly geom: ReadonlyMap<string, YardSegGeom>;
  /** Throat (spine entry) segment + the two slot segments + the tap switch ids. */
  readonly throatSegment: string;
  readonly entrySlot: string;
  readonly sparesSlot: string;
  readonly tapA: string;
  readonly tapB: string;
}

/**
 * Build the yard interior. The spine runs west→east off the throat in three
 * stretches split at the two taps; tap A diverts onto slot A, tap B onto slot B.
 * Each tap is a switch (`through` | `slot`). Slots are buffered dead-ends.
 */
export function buildYardLayout(): YardLayout {
  const Y = 600; // spine world-y
  const defs: Array<readonly [string, YardSegGeom, { endBuffered?: boolean }]> = [
    ['spine0', { ax: 200, ay: Y, bx: 700, by: Y }, {}],
    ['spine1', { ax: 700, ay: Y, bx: 1100, by: Y }, {}],
    ['spine2', { ax: 1100, ay: Y, bx: 1700, by: Y }, {}],
    ['legA', { ax: 700, ay: Y, bx: 820, by: Y - 200 }, {}],
    ['slotA', { ax: 820, ay: Y - 200, bx: 1320, by: Y - 200 }, { endBuffered: true }],
    ['legB', { ax: 1100, ay: Y, bx: 1220, by: Y + 200 }, {}],
    ['slotB', { ax: 1220, ay: Y + 200, bx: 1720, by: Y + 200 }, { endBuffered: true }],
  ];
  const geom = new Map<string, YardSegGeom>();
  const segments = new Map<string, Rail>();
  for (const [id, g, ends] of defs) {
    geom.set(id, g);
    segments.set(id, straightSeg(g.ax, g.ay, g.bx, g.by, ends));
  }
  const links: NetLink[] = [
    { from: 'spine0', to: 'spine1', when: { switchId: 'tapA', position: 'through' } },
    { from: 'spine0', to: 'legA', when: { switchId: 'tapA', position: 'slot' } },
    { from: 'legA', to: 'slotA' },
    { from: 'spine1', to: 'spine2', when: { switchId: 'tapB', position: 'through' } },
    { from: 'spine1', to: 'legB', when: { switchId: 'tapB', position: 'slot' } },
    { from: 'legB', to: 'slotB' },
  ];
  return {
    net: buildNetwork(segments, links),
    geom,
    throatSegment: 'spine0',
    entrySlot: 'slotA',
    sparesSlot: 'slotB',
    tapA: 'tapA',
    tapB: 'tapB',
  };
}
