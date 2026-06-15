/**
 * The BRANCHING layout (FROZEN SPEC §2): a single switched `RailNetwork` driven
 * by the REAL `@trainframe/server` scheduler (route + clearance based), not the
 * bespoke `RailyardDemoController`. It is a proper running MAIN loop with real
 * curved corners enclosing the embedded railyard, plus a second independent
 * BRANCH loop that diverges off a real junction and rejoins the main line — so
 * the scheduler can route distinct trains down distinct branches via real
 * `requires_switch_state` edges.
 *
 * Two main-line junctions:
 *   - `Jloop` at `M-main-w` (`leftA.end`): `thru` continues down the left
 *     straight; `yard` peels off the connector into the yard west throat. Owned
 *     by the `YardZoneDevice` (the zone owns its own entry tap).
 *   - `Jspur` at `M-spur` (`rightB.end`): `thru` carries on round the top corner
 *     back to `M-top`; `branch` diverges up into the scenic BRANCH loop, which
 *     rejoins the main line at `M-top` with heading preserved (no 180° flip).
 *
 * The yard interior (its `Jw`/`Je` switches + slots) is OPAQUE: it emits NO core
 * markers. Core sees only `M-yard-throat` (the zone boundary) and `M-yard-far`.
 *
 * Built from the SAME primitives the yard uses (`straightSeg`, `cornerSeg`,
 * smooth curves) plus the real `buildYardLayout` network merged in wholesale —
 * its segment ids, `Jw`/`Je` switches and slots preserved — exactly as
 * `railyard-scene.ts` does. Pure geometry/topology, DOM-free.
 */
import type { LayoutMarker } from '@trainframe/protocol';
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import type { Rail } from './rail.js';
import { cornerSeg } from './railyard-scene.js';
import { type YardLayout, type YardSegGeom, buildYardLayout, straightSeg } from './yard.js';

/** Which segment end a marker is anchored at. */
export type MarkerEnd = 'start' | 'end';

/** The protocol marker-kind union (no `MarkerKind` type is exported from the
 *  protocol package, so derive it from `LayoutMarker.kind` — the canonical
 *  source, which includes `yard_entry`/`unspecified`). */
export type MarkerKind = LayoutMarker['kind'];

/** A logical marker pinned to a physics segment. Core's view of the layout is
 *  the set of these; physics knows only segments. */
export interface SceneMarker {
  readonly id: string;
  /** Physics segment id this marker is anchored to. */
  readonly segment: string;
  /** Anchored at this segment end (omit when `distAlongMm` is set). */
  readonly end: MarkerEnd;
  /** Set instead of `end` for a mid-segment station marker (distance along the
   *  rail from its start, mm). */
  readonly distAlongMm?: number;
  /** Protocol marker kind. */
  readonly kind: MarkerKind;
}

/** A junction-kind marker paired to a physics switch + its valid positions. */
export interface SceneJunction {
  readonly markerId: string;
  readonly switchId: string;
  readonly positions: readonly string[];
}

/** A loop block: a running-line segment in travel order around a cycle. */
export interface LoopBlock {
  readonly id: string;
  readonly geom: YardSegGeom;
  readonly curved: boolean;
}

/** A running loop the scheduler circulates as a cycle. `main` encloses the yard
 *  and feeds it; `branch` is an independent scenic ring. */
export interface LoopGroup {
  readonly id: string;
  readonly blocks: readonly LoopBlock[];
  readonly feedsYard: boolean;
}

/** A station platform beside a running line — drawn furniture only. */
export interface Station {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly angleDeg: number;
  readonly side: 1 | -1;
  readonly length: number;
}

export interface BranchingScene {
  readonly net: RailNetwork;
  /** Segment id → world endpoints (loop blocks + connectors + yard segments). */
  readonly geom: ReadonlyMap<string, YardSegGeom>;
  /** Every running loop in the scene (`main`, `branch`), each its own cycle. */
  readonly loops: readonly LoopGroup[];
  /** Station platforms to draw. */
  readonly stations: readonly Station[];
  /** The embedded yard (its `YardController`-ready layout). */
  readonly yard: YardLayout;
  /** The core markers (the layer the scheduler sees). */
  readonly markers: readonly SceneMarker[];
  /** The junction markers paired to physics switches. */
  readonly junctions: readonly SceneJunction[];
  /** The yard-entry boundary marker id (`M-yard-throat`). */
  readonly throatMarker: string;
  /** The yard's entry/spares slot ids the demo services with. */
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
const LEFT_X = YARD_WEST.x - R;
const RIGHT_X = YARD_EAST.x + R;
const BOTTOM_Y = 1000;
const TOP_Y = -360;
/* Where on the left/right straights the yard branch leaves / returns (world y),
 * one radius above each throat so the connector is a clean quarter circle. */
const DIVERGE_Y = YARD_WEST.y - R;
const REJOIN_Y = YARD_EAST.y - R;

/* BRANCH loop footprint (world mm): a rounded rectangle nested clear of the yard
 * ladder, diverging UP off the spur node and rejoining the main top straight. */
const BR_LEFT = 520;
const BR_TOP = TOP_Y - 520;

/** Helper to register a straight loop block. */
function makeStraight(
  segments: Map<string, Rail>,
  geom: Map<string, YardSegGeom>,
  blocks: LoopBlock[],
  id: string,
  g: YardSegGeom,
): void {
  segments.set(id, straightSeg(g.ax, g.ay, g.bx, g.by));
  geom.set(id, g);
  blocks.push({ id, geom: g, curved: false });
}

/** Helper to register a curved loop block. */
function makeCorner(
  segments: Map<string, Rail>,
  geom: Map<string, YardSegGeom>,
  blocks: LoopBlock[],
  id: string,
  g: YardSegGeom,
  inDeg: number,
  outDeg: number,
): void {
  segments.set(id, cornerSeg(g.ax, g.ay, g.bx, g.by, inDeg, outDeg));
  geom.set(id, g);
  blocks.push({ id, geom: g, curved: true });
}

/** Build the MAIN loop blocks (counter-clockwise) and register them. */
function buildMainLoop(segments: Map<string, Rail>, geom: Map<string, YardSegGeom>): LoopBlock[] {
  const blocks: LoopBlock[] = [];
  const s = (id: string, g: YardSegGeom): void => makeStraight(segments, geom, blocks, id, g);
  const c = (id: string, g: YardSegGeom, i: number, o: number): void =>
    makeCorner(segments, geom, blocks, id, g, i, o);
  /* LEFT straight descends (south, 90°); the yard branch diverges off it at
   *  `leftA.end` (`Jloop`). bottom heads EAST; RIGHT straight ascends (north,
   *  -90°) — the yard return rejoins at `rightB.start`, and the spur diverges at
   *  `rightB.end`. Real curved corners join the four runs. */
  s('leftA', { ax: LEFT_X, ay: TOP_Y + R, bx: LEFT_X, by: DIVERGE_Y });
  s('leftB', { ax: LEFT_X, ay: DIVERGE_Y, bx: LEFT_X, by: BOTTOM_Y - R });
  c('cSW', { ax: LEFT_X, ay: BOTTOM_Y - R, bx: LEFT_X + R, by: BOTTOM_Y }, 90, 0);
  s('bottom', { ax: LEFT_X + R, ay: BOTTOM_Y, bx: RIGHT_X - R, by: BOTTOM_Y });
  c('cSE', { ax: RIGHT_X - R, ay: BOTTOM_Y, bx: RIGHT_X, by: BOTTOM_Y - R }, 0, -90);
  s('rightA', { ax: RIGHT_X, ay: BOTTOM_Y - R, bx: RIGHT_X, by: REJOIN_Y });
  s('rightB', { ax: RIGHT_X, ay: REJOIN_Y, bx: RIGHT_X, by: TOP_Y + R });
  c('cNE', { ax: RIGHT_X, ay: TOP_Y + R, bx: RIGHT_X - R, by: TOP_Y }, -90, 180);
  s('top', { ax: RIGHT_X - R, ay: TOP_Y, bx: LEFT_X + R, by: TOP_Y });
  c('cNW', { ax: LEFT_X + R, ay: TOP_Y, bx: LEFT_X, by: TOP_Y + R }, 180, 90);
  return blocks;
}

/** Chain the main loop as a CYCLE. `leftA` gets a SWITCHED through-link to
 *  `leftB` (`Jloop=thru`); `rightB` gets a SWITCHED through-link to its corner
 *  (`Jspur=thru`). Every other joint is plain. */
function linkMainLoop(blocks: readonly LoopBlock[], links: NetLink[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const cur = blocks[i];
    const nxt = blocks[(i + 1) % blocks.length];
    if (cur === undefined || nxt === undefined) continue;
    if (cur.id === 'leftA') {
      links.push({ from: cur.id, to: nxt.id, when: { switchId: 'Jloop', position: 'thru' } });
    } else if (cur.id === 'rightB') {
      links.push({ from: cur.id, to: nxt.id, when: { switchId: 'Jspur', position: 'thru' } });
    } else {
      links.push({ from: cur.id, to: nxt.id });
    }
  }
}

/** Build the BRANCH loop: diverges UP off `rightB.end` (`Jspur=branch`), runs a
 *  rounded rectangle, and rejoins the main `top` straight (heading west — facing
 *  preserved). Registered into the shared maps; returns its blocks. */
function buildBranchLoop(
  segments: Map<string, Rail>,
  geom: Map<string, YardSegGeom>,
  links: NetLink[],
): LoopBlock[] {
  const blocks: LoopBlock[] = [];
  const s = (id: string, g: YardSegGeom): void => makeStraight(segments, geom, blocks, id, g);
  const c = (id: string, g: YardSegGeom, i: number, o: number): void =>
    makeCorner(segments, geom, blocks, id, g, i, o);
  /* From the spur node (`rightB.end` at (RIGHT_X, TOP_Y+R), heading north -90°)
   *  curve north-then-west onto `bTop` (heading west, 180°), run west along the
   *  branch top, then curve south-then-west down `bBottom` to rejoin the main
   *  `top` straight at its start (heading west, 180° — facing preserved). */
  c('bcNE', { ax: RIGHT_X, ay: TOP_Y + R, bx: RIGHT_X - R, by: BR_TOP }, -90, 180);
  s('bTop', { ax: RIGHT_X - R, ay: BR_TOP, bx: BR_LEFT, by: BR_TOP });
  c('bcSW', { ax: BR_LEFT, ay: BR_TOP, bx: BR_LEFT - R, by: BR_TOP + R }, 180, 90);
  s('bBottom', { ax: BR_LEFT - R, ay: BR_TOP + R, bx: BR_LEFT - R, by: TOP_Y - R });
  c('bcSE', { ax: BR_LEFT - R, ay: TOP_Y - R, bx: RIGHT_X - R, by: TOP_Y }, 90, 180);
  /* Branch diverge + chain. The spur tap is switched; the rest plain; the last
   *  branch corner rejoins the main `top` straight forward (heading preserved). */
  links.push({ from: 'rightB', to: 'bcNE', when: { switchId: 'Jspur', position: 'branch' } });
  links.push({ from: 'bcNE', to: 'bTop' });
  links.push({ from: 'bTop', to: 'bBottom' });
  links.push({ from: 'bBottom', to: 'bcSE' });
  links.push({ from: 'bcSE', to: 'top' });
  return blocks;
}

/** Rebuild the yard's internal link topology (mirrors `buildYardLayout`) so the
 *  combined network owns the same diverge/converge ladder. */
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

/** Merge the embedded yard network + register the two connector legs (loop↔yard).
 *  The diverge leg curves the left straight (south) round to EAST into the yard
 *  west throat; the return leg curves the yard east throat (east) round to NORTH
 *  onto the right straight — so the train enters and leaves heading east. */
function embedYard(
  segments: Map<string, Rail>,
  geom: Map<string, YardSegGeom>,
  links: NetLink[],
  slotCount: number,
): YardLayout {
  const yard = buildYardLayout(slotCount);
  for (const seg of yard.net.segments()) segments.set(seg, yard.net.railOf(seg));
  for (const [id, g] of yard.geom) geom.set(id, g);
  for (const l of yardLinks(yard, slotCount)) links.push(l);

  const gIn: YardSegGeom = { ax: LEFT_X, ay: DIVERGE_Y, bx: YARD_WEST.x, by: YARD_WEST.y };
  segments.set('connIn', cornerSeg(gIn.ax, gIn.ay, gIn.bx, gIn.by, 90, 0));
  geom.set('connIn', gIn);
  links.push({ from: 'leftA', to: 'connIn', when: { switchId: 'Jloop', position: 'yard' } });
  links.push({ from: 'connIn', to: yard.leadWest });

  const gOut: YardSegGeom = { ax: YARD_EAST.x, ay: YARD_EAST.y, bx: RIGHT_X, by: REJOIN_Y };
  segments.set('connOut', cornerSeg(gOut.ax, gOut.ay, gOut.bx, gOut.by, 0, -90));
  geom.set('connOut', gOut);
  links.push({ from: yard.leadEast, to: 'connOut' });
  links.push({ from: 'connOut', to: 'rightB' });
  return yard;
}

/** The full core-marker list (FROZEN SPEC §2). Yard interior emits none. */
function sceneMarkers(): SceneMarker[] {
  return [
    { id: 'M-top', segment: 'top', end: 'end', kind: 'block_boundary' },
    { id: 'M-main-w', segment: 'leftA', end: 'end', kind: 'junction' },
    /* Placed well DOWN leftB (not at its start) so it sits clear of BOTH the
     *  diverge node (`M-main-w` at leftB's start, the same world point) AND the
     *  yard-tap connector that curves away from that node — a position-based
     *  marker reader would otherwise fire it spuriously as a yard-bound train
     *  swings through the connector. Far enough south that the connector curve has
     *  long since left its capture radius. */
    { id: 'M-main-wlow', segment: 'leftB', end: 'start', distAlongMm: 300, kind: 'block_boundary' },
    { id: 'M-central', segment: 'bottom', end: 'start', distAlongMm: 600, kind: 'station_stop' },
    { id: 'M-main-e', segment: 'rightB', end: 'start', kind: 'junction' },
    { id: 'M-spur', segment: 'rightB', end: 'end', kind: 'junction' },
    { id: 'M-branch-top', segment: 'bTop', end: 'end', kind: 'station_stop' },
    { id: 'M-branch-bot', segment: 'bBottom', end: 'start', kind: 'block_boundary' },
    { id: 'M-yard-throat', segment: 'leadW', end: 'start', kind: 'yard_entry' },
    { id: 'M-yard-far', segment: 'leadE', end: 'end', kind: 'block_boundary' },
  ];
}

/** Build the branching scene. `slotCount` sizes the embedded yard (default 3). */
export function buildBranchingScene(slotCount = 3): BranchingScene {
  const segments = new Map<string, Rail>();
  const geom = new Map<string, YardSegGeom>();
  const links: NetLink[] = [];

  const mainBlocks = buildMainLoop(segments, geom);
  linkMainLoop(mainBlocks, links);
  const branchBlocks = buildBranchLoop(segments, geom, links);
  const yard = embedYard(segments, geom, links, slotCount);

  const loops: LoopGroup[] = [
    { id: 'main', blocks: mainBlocks, feedsYard: true },
    { id: 'branch', blocks: branchBlocks, feedsYard: false },
  ];

  const stations: Station[] = [
    {
      id: 'central',
      name: 'CENTRAL',
      x: LEFT_X + R + 600,
      y: BOTTOM_Y,
      angleDeg: 0,
      side: 1,
      length: 460,
    },
    {
      id: 'hillside',
      name: 'HILLSIDE',
      x: BR_LEFT + 600,
      y: BR_TOP,
      angleDeg: 180,
      side: 1,
      length: 420,
    },
  ];

  const junctions: SceneJunction[] = [
    { markerId: 'M-main-w', switchId: 'Jloop', positions: ['thru', 'yard'] },
    { markerId: 'M-spur', switchId: 'Jspur', positions: ['thru', 'branch'] },
  ];

  return {
    net: buildNetwork(segments, links),
    geom,
    loops,
    stations,
    yard,
    markers: sceneMarkers(),
    junctions,
    throatMarker: 'M-yard-throat',
    entrySlot: yard.slots[0] ?? 'slot0',
    sparesSlot: yard.slots[1] ?? 'slot1',
  };
}
