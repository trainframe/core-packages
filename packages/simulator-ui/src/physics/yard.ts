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
 * The ladder legs are smooth S-bend curves (horizontal tangents into the spine
 * and the slots) so a train flows through the junction with continuous heading
 * rather than snapping round a corner — and they carry real curvature, so taking
 * one far too fast would derail (the physics' lateral-acceleration limit). World
 * mm. The two diverge/converge nodes are 3-position switches (`Jw`, `Je`).
 */
import type { RailPose } from '../track/pieces.js';
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

/** A smooth S-bend ladder leg: a cubic Bézier from `(ax,ay)` to `(bx,by)` with
 *  HORIZONTAL tangents at both ends, so it meets the spine and the slot without a
 *  kink. Arc-length sampled so a body drives it at a true speed; curvature is the
 *  real bend (so an over-fast train would derail on it). */
export function curveSeg(ax: number, ay: number, bx: number, by: number): Rail {
  const hx = (bx - ax) * 0.5; // horizontal control handles → horizontal end tangents
  const at01 = (t: number): { x: number; y: number } => {
    const u = 1 - t;
    const x =
      u * u * u * ax + 3 * u * u * t * (ax + hx) + 3 * u * t * t * (bx - hx) + t * t * t * bx;
    const y = u * u * u * ay + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * by;
    return { x, y };
  };
  // Arc-length table.
  const N = 48;
  const samples: { d: number; x: number; y: number }[] = [];
  let len = 0;
  let prev = at01(0);
  samples.push({ d: 0, x: prev.x, y: prev.y });
  for (let i = 1; i <= N; i++) {
    const p = at01(i / N);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    samples.push({ d: len, x: p.x, y: p.y });
    prev = p;
  }
  const pose = (d: number): RailPose => {
    const dd = Math.max(0, Math.min(len, d));
    let i = 1;
    while (i < samples.length && (samples[i]?.d ?? len) < dd) i++;
    const a = samples[i - 1];
    const b = samples[i] ?? a;
    if (a === undefined || b === undefined) return { x: ax, y: ay, headingDeg: 0 };
    const f = b.d - a.d > 0 ? (dd - a.d) / (b.d - a.d) : 0;
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      headingDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
    };
  };
  return {
    length: len,
    at: pose,
    curvatureAt: (d) => {
      const e = 3;
      const h1 = pose(Math.max(0, d - e)).headingDeg;
      const h2 = pose(Math.min(len, d + e)).headingDeg;
      const dh = ((h2 - h1 + 540) % 360) - 180;
      const ds = Math.min(len, d + e) - Math.max(0, d - e);
      return ds > 0 ? (dh * Math.PI) / 180 / ds : 0;
    },
    pieceTypeAt: () => 'curve',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

/** A segment's world endpoints — for bounds + the controller's slot positions. */
export interface YardSegGeom {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

export interface YardLayout {
  readonly net: RailNetwork;
  /** Segment id → world endpoints. */
  readonly geom: ReadonlyMap<string, YardSegGeom>;
  readonly leadWest: string;
  readonly leadEast: string;
  readonly slots: readonly string[];
  readonly westSwitch: string;
  readonly eastSwitch: string;
}

const SPINE_Y = 600;
const SLOT_GAP = 150;
/** Spine x of the diverge node, the slot mouths, and the converge node. */
const DIVERGE_X = 560;
const SLOT_WEST_X = 860;
const SLOT_EAST_X = 1340;
const CONVERGE_X = 1640;

/** World-y of slot `i` — fanned symmetrically about the spine (0 above, 1 below,
 *  2 further above, …) so slots never collide with the running line. */
function slotY(i: number): number {
  const rank = Math.floor(i / 2) + 1;
  const side = i % 2 === 0 ? -1 : 1;
  return SPINE_Y + side * rank * SLOT_GAP;
}

/**
 * Build the yard with `slotCount` through-slots (default 4) — configurable so the
 * yard can be as wide as a layout needs. A single diverge switch (`Jw`) and a
 * single converge switch (`Je`), each with positions `thru` + `slot0…slotN-1`,
 * fan the spine into the slots via smooth S-bend legs and rejoin them.
 */
export function buildYardLayout(slotCount = 4): YardLayout {
  const geom = new Map<string, YardSegGeom>();
  const segments = new Map<string, Rail>();
  const links: NetLink[] = [];

  const addStraight = (id: string, g: YardSegGeom): void => {
    geom.set(id, g);
    segments.set(id, straightSeg(g.ax, g.ay, g.bx, g.by));
  };
  const addCurve = (id: string, g: YardSegGeom): void => {
    geom.set(id, g);
    segments.set(id, curveSeg(g.ax, g.ay, g.bx, g.by));
  };

  addStraight('leadW', { ax: 150, ay: SPINE_Y, bx: DIVERGE_X, by: SPINE_Y });
  addStraight('thru', { ax: DIVERGE_X, ay: SPINE_Y, bx: CONVERGE_X, by: SPINE_Y });
  addStraight('leadE', { ax: CONVERGE_X, ay: SPINE_Y, bx: 2050, by: SPINE_Y });
  links.push({ from: 'leadW', to: 'thru', when: { switchId: 'Jw', position: 'thru' } });
  links.push({ from: 'thru', to: 'leadE', when: { switchId: 'Je', position: 'thru' } });

  const slots: string[] = [];
  for (let i = 0; i < slotCount; i++) {
    const slot = `slot${i}`;
    const y = slotY(i);
    slots.push(slot);
    addStraight(slot, { ax: SLOT_WEST_X, ay: y, bx: SLOT_EAST_X, by: y });
    addCurve(`wleg${i}`, { ax: DIVERGE_X, ay: SPINE_Y, bx: SLOT_WEST_X, by: y });
    addCurve(`eleg${i}`, { ax: SLOT_EAST_X, ay: y, bx: CONVERGE_X, by: SPINE_Y });
    links.push({ from: 'leadW', to: `wleg${i}`, when: { switchId: 'Jw', position: slot } });
    links.push({ from: `wleg${i}`, to: slot });
    links.push({ from: slot, to: `eleg${i}` });
    links.push({ from: `eleg${i}`, to: 'leadE', when: { switchId: 'Je', position: slot } });
  }

  return {
    net: buildNetwork(segments, links),
    geom,
    leadWest: 'leadW',
    leadEast: 'leadE',
    slots,
    westSwitch: 'Jw',
    eastSwitch: 'Je',
  };
}
