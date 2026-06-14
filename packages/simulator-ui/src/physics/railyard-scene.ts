/**
 * The RAILYARD DEMO layout (ADR-030): a single switched `RailNetwork` that is a
 * proper running LOOP with real curved corners — not a plain oval — and a
 * JUNCTION that splits the running line off into the railyard branch, with the
 * yard reachable through that split and rejoining the loop on the far side.
 *
 * The loop runs COUNTER-CLOCKWISE and ENCLOSES the yard. The yard branch peels
 * off the loop's LEFT (descending) straight through a quarter-turn into the
 * yard's WEST throat (heading EAST, the way the yard spine runs), so a serviced
 * train keeps its world heading throughout — it is shunted PHYSICALLY on the real
 * rails, leaves the EAST throat still heading east, and a return quarter-turn
 * lifts it back onto the loop's RIGHT (ascending) straight with its facing
 * UNCHANGED (no phantom 180° flip).
 *
 * The loop is cut into named blocks so the controller can grant block-by-block
 * clearance (a train only advances into the next block when it is empty —
 * same-direction running + block separation = collision-free by construction).
 *
 * Built from the SAME primitives the yard uses (`straightSeg`, `buildNetwork`,
 * smooth Bézier curves) plus a quarter-turn corner segment. The yard interior is
 * the real `buildYardLayout` network, merged in wholesale (its segment ids,
 * `Jw`/`Je` switches and slots preserved) so the unmodified `YardController`
 * drives it. Pure geometry/topology, DOM-free.
 */
import type { RailPose } from '../track/pieces.js';
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import type { Rail } from './rail.js';
import { type YardLayout, type YardSegGeom, buildYardLayout, straightSeg } from './yard.js';

/**
 * A quarter-turn corner as an arc-length-sampled cubic Bézier from `(ax,ay)` to
 * `(bx,by)`, with the entry tangent along `inDeg` and the exit tangent along
 * `outDeg` (both world degrees). The control handles sit along those tangents
 * (the classic ~0.55·chord circle approximation), so the corner meets the
 * straights without a kink and carries real curvature — taking it far too fast
 * would derail (the lateral-acceleration limit the world enforces).
 */
export function cornerSeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  inDeg: number,
  outDeg: number,
): Rail {
  const inRad = (inDeg * Math.PI) / 180;
  const outRad = (outDeg * Math.PI) / 180;
  const chord = Math.hypot(bx - ax, by - ay);
  const h = chord * 0.55;
  const c1x = ax + Math.cos(inRad) * h;
  const c1y = ay + Math.sin(inRad) * h;
  const c2x = bx - Math.cos(outRad) * h;
  const c2y = by - Math.sin(outRad) * h;
  const at01 = (t: number): { x: number; y: number } => {
    const u = 1 - t;
    const x = u * u * u * ax + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * bx;
    const y = u * u * u * ay + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * by;
    return { x, y };
  };
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
    if (a === undefined || b === undefined) return { x: ax, y: ay, headingDeg: inDeg };
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

/** A loop block: a running-line segment the controller treats as a clearance
 *  block. Order is the travel order around the loop. */
export interface LoopBlock {
  readonly id: string;
  readonly geom: YardSegGeom;
  /** True for the curved corners (so a renderer / test can find the curves). */
  readonly curved: boolean;
}

/** A running LOOP the controller circulates as its own block-clearance cycle. The
 *  MAIN loop (`feedsYard`) encloses the railyard and peels trains into it; the
 *  others are independent rings with their own trains + stations. */
export interface LoopGroup {
  readonly id: string;
  /** This loop's blocks in travel order (a cycle: last links back to first). */
  readonly blocks: readonly LoopBlock[];
  /** True for the one loop wired to the yard diverge. */
  readonly feedsYard: boolean;
}

/** A station platform beside a running line — drawn furniture (a platform slab +
 *  a name board), purely for the scene. `angleDeg` is the track heading there; the
 *  platform is offset to `side` (+1 = right of travel, −1 = left). */
export interface Station {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly angleDeg: number;
  readonly side: 1 | -1;
  readonly length: number;
}

export interface RailyardScene {
  readonly net: RailNetwork;
  /** Segment id → world endpoints (loop blocks + connectors + yard segments). */
  readonly geom: ReadonlyMap<string, YardSegGeom>;
  /** The MAIN running-loop blocks, in travel order (the yard-fed loop). Kept for
   *  callers that only care about the principal loop; see `loops` for all rings. */
  readonly loop: readonly LoopBlock[];
  /** Every running loop in the scene (main + scenic rings), each its own cycle. */
  readonly loops: readonly LoopGroup[];
  /** Station platforms to draw. */
  readonly stations: readonly Station[];
  /** The block off which the yard branch diverges. */
  readonly divergeBlock: string;
  /** The loop block the yard rejoins onto. */
  readonly rejoinBlock: string;
  /** The diverge switch id and its two positions. */
  readonly loopSwitch: string;
  readonly loopThruPos: string;
  readonly loopYardPos: string;
  /** The connector legs (diverge→yard, yard→loop) — rendered, not loop blocks. */
  readonly connectors: readonly string[];
  /** The embedded yard (its `YardController`-ready layout). */
  readonly yard: YardLayout;
  /** The yard's entry/spares slot ids the railyard demo services with. */
  readonly entrySlot: string;
  readonly sparesSlot: string;
}

/* The yard's throat world points (from `buildYardLayout` — fixed). The loop is
 * sized so its quarter-turn connectors land exactly on these, heading east. */
const YARD_WEST = { x: 150, y: 600 };
const YARD_EAST = { x: 2050, y: 600 };
/* Corner radius — generous, so the loop reads as rounded and a train holds the
 * bend comfortably at running speed (well under the derail limit). */
const R = 320;
/* Loop footprint (world mm): the left straight sits one radius west of the yard
 * west throat and the right straight one radius east of the east throat, so the
 * connector quarter-turns close cleanly. The loop encloses the yard. */
const LEFT_X = YARD_WEST.x - R;
const RIGHT_X = YARD_EAST.x + R;
const BOTTOM_Y = 1000;
const TOP_Y = -360;
/* Where on the left/right straights the yard branch leaves / returns (world y),
 * one radius above each throat so the connector is a clean quarter circle. */
const DIVERGE_Y = YARD_WEST.y - R;
const REJOIN_Y = YARD_EAST.y - R;

/* Inner ring footprint (world mm): a smaller rounded rectangle nested in the
 * upper interior of the main loop, clear of the yard ladder (which fans around
 * y≈600, topmost slot at y≈300) and of the diverge connector on the left. */
const IN_LEFT = 320;
const IN_RIGHT = 1880;
const IN_TOP = -260;
const IN_BOT = 170;
const IR = 165;

/** Build the railyard demo: a counter-clockwise rounded MAIN loop in named blocks
 *  enclosing the real yard (with a diverge junction into it and a rejoin onto the
 *  loop), PLUS an independent inner ring, plus station platforms. `slotCount`
 *  sizes the embedded yard (default 3). */
export function buildRailyardScene(slotCount = 3): RailyardScene {
  const segments = new Map<string, Rail>();
  const geom = new Map<string, YardSegGeom>();
  const links: NetLink[] = [];
  const loop: LoopBlock[] = [];

  const addStraight = (id: string, g: YardSegGeom): void => {
    segments.set(id, straightSeg(g.ax, g.ay, g.bx, g.by));
    geom.set(id, g);
    loop.push({ id, geom: g, curved: false });
  };
  const addCorner = (id: string, g: YardSegGeom, inDeg: number, outDeg: number): void => {
    segments.set(id, cornerSeg(g.ax, g.ay, g.bx, g.by, inDeg, outDeg));
    geom.set(id, g);
    loop.push({ id, geom: g, curved: true });
  };

  /* Counter-clockwise. The LEFT straight descends (heading south, 90°) — the yard
   *  branch diverges off it part-way down (`leftA` above the diverge, `leftB`
   *  below). The bottom straight heads EAST, then up the RIGHT straight (north,
   *  -90°) where the yard return rejoins (`rightA` below the rejoin, `rightB`
   *  above), then west along the top. Real curved corners join the four runs. */
  addStraight('leftA', { ax: LEFT_X, ay: TOP_Y + R, bx: LEFT_X, by: DIVERGE_Y });
  addStraight('leftB', { ax: LEFT_X, ay: DIVERGE_Y, bx: LEFT_X, by: BOTTOM_Y - R });
  addCorner('cSW', { ax: LEFT_X, ay: BOTTOM_Y - R, bx: LEFT_X + R, by: BOTTOM_Y }, 90, 0);
  addStraight('bottom', { ax: LEFT_X + R, ay: BOTTOM_Y, bx: RIGHT_X - R, by: BOTTOM_Y });
  addCorner('cSE', { ax: RIGHT_X - R, ay: BOTTOM_Y, bx: RIGHT_X, by: BOTTOM_Y - R }, 0, -90);
  addStraight('rightA', { ax: RIGHT_X, ay: BOTTOM_Y - R, bx: RIGHT_X, by: REJOIN_Y });
  addStraight('rightB', { ax: RIGHT_X, ay: REJOIN_Y, bx: RIGHT_X, by: TOP_Y + R });
  addCorner('cNE', { ax: RIGHT_X, ay: TOP_Y + R, bx: RIGHT_X - R, by: TOP_Y }, -90, 180);
  addStraight('top', { ax: RIGHT_X - R, ay: TOP_Y, bx: LEFT_X + R, by: TOP_Y });
  addCorner('cNW', { ax: LEFT_X + R, ay: TOP_Y, bx: LEFT_X, by: TOP_Y + R }, 180, 90);

  /* Chain the loop as a CYCLE. The diverge block (`leftA`) gets a SWITCHED
   *  through-link to `leftB`; every other joint is a plain joint. */
  for (let i = 0; i < loop.length; i++) {
    const cur = loop[i];
    const nxt = loop[(i + 1) % loop.length];
    if (cur === undefined || nxt === undefined) continue;
    if (cur.id === 'leftA') {
      links.push({ from: cur.id, to: nxt.id, when: { switchId: 'Jloop', position: 'thru' } });
    } else {
      links.push({ from: cur.id, to: nxt.id });
    }
  }

  /* The embedded yard (the REAL yard network — ids/switches/slots preserved). */
  const yard = buildYardLayout(slotCount);
  for (const seg of yard.net.segments()) segments.set(seg, yard.net.railOf(seg));
  for (const [id, g] of yard.geom) geom.set(id, g);
  for (const l of yardLinks(yard, slotCount)) links.push(l);

  /* Connector legs — real quarter-turn curves. The diverge leg curves from the
   *  left straight (heading south) round to EAST into the yard west throat; the
   *  return leg curves from the yard east throat (heading east) round to NORTH
   *  onto the right straight. So the train enters and leaves heading east — its
   *  facing never flips. */
  const connectors: string[] = [];
  {
    const g: YardSegGeom = { ax: LEFT_X, ay: DIVERGE_Y, bx: YARD_WEST.x, by: YARD_WEST.y };
    segments.set('connIn', cornerSeg(g.ax, g.ay, g.bx, g.by, 90, 0));
    geom.set('connIn', g);
    connectors.push('connIn');
    links.push({ from: 'leftA', to: 'connIn', when: { switchId: 'Jloop', position: 'yard' } });
    links.push({ from: 'connIn', to: yard.leadWest });
  }
  {
    const g: YardSegGeom = { ax: YARD_EAST.x, ay: YARD_EAST.y, bx: RIGHT_X, by: REJOIN_Y };
    segments.set('connOut', cornerSeg(g.ax, g.ay, g.bx, g.by, 0, -90));
    geom.set('connOut', g);
    connectors.push('connOut');
    links.push({ from: yard.leadEast, to: 'connOut' });
    links.push({ from: 'connOut', to: 'rightB' });
  }

  /* The INNER ring — its own closed cycle nested above the yard, built as a
   *  second independent block-clearance loop. */
  const inner = buildInnerRing(segments, geom, links);

  const loops: LoopGroup[] = [
    { id: 'main', blocks: loop, feedsYard: true },
    { id: 'inner', blocks: inner, feedsYard: false },
  ];

  /* Station platforms (drawn furniture). The main-line halt sits on the bottom
   *  straight (east-bound, platform below the line); the inner ring's halt sits on
   *  its bottom straight (platform below); a third overlooks the top of the loop. */
  const stations: Station[] = [
    { id: 'central', name: 'CENTRAL', x: 760, y: BOTTOM_Y, angleDeg: 0, side: 1, length: 460 },
    { id: 'parkside', name: 'PARKSIDE', x: 1100, y: IN_BOT, angleDeg: 0, side: 1, length: 360 },
    { id: 'summit', name: 'SUMMIT', x: 1500, y: TOP_Y, angleDeg: 180, side: 1, length: 420 },
  ];

  return {
    net: buildNetwork(segments, links),
    geom,
    loop,
    loops,
    stations,
    divergeBlock: 'leftA',
    rejoinBlock: 'rightB',
    loopSwitch: 'Jloop',
    loopThruPos: 'thru',
    loopYardPos: 'yard',
    connectors,
    yard,
    entrySlot: yard.slots[0] ?? 'slot0',
    sparesSlot: yard.slots[1] ?? 'slot1',
  };
}

/** Build the inner ring: a smaller rounded-rectangle cycle of straights + curved
 *  corners with plain joints (no switches), registered into the shared
 *  `segments`/`geom`/`links`. Returns its blocks in travel order. */
function buildInnerRing(
  segments: Map<string, Rail>,
  geom: Map<string, YardSegGeom>,
  links: NetLink[],
): LoopBlock[] {
  const inner: LoopBlock[] = [];
  const straight = (id: string, g: YardSegGeom): void => {
    segments.set(id, straightSeg(g.ax, g.ay, g.bx, g.by));
    geom.set(id, g);
    inner.push({ id, geom: g, curved: false });
  };
  const corner = (id: string, g: YardSegGeom, inDeg: number, outDeg: number): void => {
    segments.set(id, cornerSeg(g.ax, g.ay, g.bx, g.by, inDeg, outDeg));
    geom.set(id, g);
    inner.push({ id, geom: g, curved: true });
  };
  straight('iLeft', { ax: IN_LEFT, ay: IN_TOP + IR, bx: IN_LEFT, by: IN_BOT - IR });
  corner('icSW', { ax: IN_LEFT, ay: IN_BOT - IR, bx: IN_LEFT + IR, by: IN_BOT }, 90, 0);
  straight('iBottom', { ax: IN_LEFT + IR, ay: IN_BOT, bx: IN_RIGHT - IR, by: IN_BOT });
  corner('icSE', { ax: IN_RIGHT - IR, ay: IN_BOT, bx: IN_RIGHT, by: IN_BOT - IR }, 0, -90);
  straight('iRight', { ax: IN_RIGHT, ay: IN_BOT - IR, bx: IN_RIGHT, by: IN_TOP + IR });
  corner('icNE', { ax: IN_RIGHT, ay: IN_TOP + IR, bx: IN_RIGHT - IR, by: IN_TOP }, -90, 180);
  straight('iTop', { ax: IN_RIGHT - IR, ay: IN_TOP, bx: IN_LEFT + IR, by: IN_TOP });
  corner('icNW', { ax: IN_LEFT + IR, ay: IN_TOP, bx: IN_LEFT, by: IN_TOP + IR }, 180, 90);
  for (let i = 0; i < inner.length; i++) {
    const cur = inner[i];
    const nxt = inner[(i + 1) % inner.length];
    if (cur !== undefined && nxt !== undefined) links.push({ from: cur.id, to: nxt.id });
  }
  return inner;
}

/** Rebuild the yard's internal link topology (mirrors `buildYardLayout`) so the
 *  combined network owns the same diverge/converge ladder: a single diverge
 *  (`Jw`) + converge (`Je`), `thru` + per-slot. */
function yardLinks(yard: YardLayout, slotCount: number): NetLink[] {
  const links: NetLink[] = [
    { from: yard.leadWest, to: 'thru', when: { switchId: yard.westSwitch, position: 'thru' } },
    { from: 'thru', to: yard.leadEast, when: { switchId: yard.eastSwitch, position: 'thru' } },
  ];
  for (let i = 0; i < slotCount; i++) {
    const slot = `slot${i}`;
    links.push({
      from: yard.leadWest,
      to: `wleg${i}`,
      when: { switchId: yard.westSwitch, position: slot },
    });
    links.push({ from: `wleg${i}`, to: slot });
    links.push({ from: slot, to: `eleg${i}` });
    links.push({
      from: `eleg${i}`,
      to: yard.leadEast,
      when: { switchId: yard.eastSwitch, position: slot },
    });
  }
  return links;
}
