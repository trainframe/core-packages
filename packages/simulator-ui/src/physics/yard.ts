/**
 * The railyard interior as a switched rail network (ADR-030 Plan §4). To the
 * physics the yard is ordinary track + junctions: a single line off EACH throat,
 * a diverging ladder fanning into the slots and a converging ladder rejoining
 * them on the far side (the drawn `railyard` piece's layout). A train self-drives
 * it; the yard device throws the points. It is INDIFFERENT to which throat is IN
 * — a train is serviced from whichever throat it arrived at, routed through to the
 * opposite one. Core's opaque-zone view (ADR-026/027) is the only thing that
 * treats it specially.
 *
 * Geometry here is simple straights (spine, legs, slots) — enough to drive and
 * render the choreography; the ornate wooden ladder is a separate rendering
 * concern. World-space mm. The two diverge/converge nodes are 3-position switches
 * (`Jw`, `Je`): `thru` runs the spine straight; `slotA` / `slotB` divert.
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

/** A segment's world endpoints — for the view to draw a plank along it. */
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
  /** The two throats' lead segments + the slot segments + the two ladder switches. */
  readonly leadWest: string;
  readonly leadEast: string;
  readonly slots: readonly string[];
  readonly westSwitch: string;
  readonly eastSwitch: string;
}

const SPINE_Y = 600;
const SLOT_OFFSET = 220;

export function buildYardLayout(): YardLayout {
  const slotAY = SPINE_Y - SLOT_OFFSET;
  const slotBY = SPINE_Y + SLOT_OFFSET;
  const defs: Array<readonly [string, YardSegGeom]> = [
    ['leadW', { ax: 150, ay: SPINE_Y, bx: 600, by: SPINE_Y }],
    ['thru', { ax: 600, ay: SPINE_Y, bx: 1600, by: SPINE_Y }],
    ['leadE', { ax: 1600, ay: SPINE_Y, bx: 2050, by: SPINE_Y }],
    ['wlegA', { ax: 600, ay: SPINE_Y, bx: 760, by: slotAY }],
    ['slotA', { ax: 760, ay: slotAY, bx: 1440, by: slotAY }],
    ['elegA', { ax: 1440, ay: slotAY, bx: 1600, by: SPINE_Y }],
    ['wlegB', { ax: 600, ay: SPINE_Y, bx: 760, by: slotBY }],
    ['slotB', { ax: 760, ay: slotBY, bx: 1440, by: slotBY }],
    ['elegB', { ax: 1440, ay: slotBY, bx: 1600, by: SPINE_Y }],
  ];
  const geom = new Map<string, YardSegGeom>();
  const segments = new Map<string, Rail>();
  for (const [id, g] of defs) {
    geom.set(id, g);
    segments.set(id, straightSeg(g.ax, g.ay, g.bx, g.by));
  }
  // West diverge (Jw) + east converge (Je), each a 3-position switch. The leg→slot
  // and slot→leg links are unconditional; the spine taps are switch-gated.
  const links: NetLink[] = [
    { from: 'leadW', to: 'thru', when: { switchId: 'Jw', position: 'thru' } },
    { from: 'leadW', to: 'wlegA', when: { switchId: 'Jw', position: 'slotA' } },
    { from: 'leadW', to: 'wlegB', when: { switchId: 'Jw', position: 'slotB' } },
    { from: 'wlegA', to: 'slotA' },
    { from: 'wlegB', to: 'slotB' },
    { from: 'slotA', to: 'elegA' },
    { from: 'slotB', to: 'elegB' },
    { from: 'thru', to: 'leadE', when: { switchId: 'Je', position: 'thru' } },
    { from: 'elegA', to: 'leadE', when: { switchId: 'Je', position: 'slotA' } },
    { from: 'elegB', to: 'leadE', when: { switchId: 'Je', position: 'slotB' } },
  ];
  return {
    net: buildNetwork(segments, links),
    geom,
    leadWest: 'leadW',
    leadEast: 'leadE',
    slots: ['slotA', 'slotB'],
    westSwitch: 'Jw',
    eastSwitch: 'Je',
  };
}
