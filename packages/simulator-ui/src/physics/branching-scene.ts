/**
 * The BRANCHING layout (FROZEN SPEC §2, reworked for the deadlock-free four-train
 * run): a single switched `RailNetwork` driven by the REAL `@trainframe/server`
 * scheduler (route + clearance based), not the bespoke `RailyardDemoController`.
 * It is a proper running MAIN loop with real curved corners, with the embedded
 * railyard spliced IN-LINE on the bottom run, plus a second scenic BRANCH loop
 * that diverges off a real junction and rejoins the main line.
 *
 * ── Why the yard is IN-LINE (and not a diverge/rejoin branch) ────────────────
 * The scheduler does NO deadlock avoidance (conflict resolution is an open design
 * question). A yard hung OFF the loop as a branch — peeling off one straight and
 * REJOINing the loop at a different, contended point — gridlocks four concurrent
 * trains: a train re-merging from the yard and a train already occupying the
 * rejoin block wait on each other in a cycle. So the yard is spliced IN-LINE on
 * the main running line, EXACTLY like the proven legacy `railyard-demo`: the
 * running line passes straight THROUGH the yard spine (`leadW → thru → leadE`),
 * its throat (`M-yard-throat`) is a marker ON the ring, and the yard is a pure
 * ZONE (ADR-027). A train routed to the throat is SUSPENDED there holding no
 * block, so a queue of trains waiting their turn never deadlocks the line — and a
 * non-serviced through train simply runs the spine on the default `thru` points.
 * A service DIVERTS the visitor into a slot (interior `Jw`/`Je`, opaque to core)
 * and returns it to the SAME through line, so there is no second merge to foul.
 *
 * One main-line junction remains:
 *   - `Jspur` at `M-spur` (`rightB.end`): `thru` carries on round the top corner
 *     back to `M-top`; `branch` diverges up into the scenic BRANCH loop, which
 *     rejoins the main line at `M-top` with heading preserved (no 180° flip).
 *
 * The yard interior (its `Jw`/`Je` switches + slots) is OPAQUE: it emits NO core
 * markers, and is NOT a scheduler-thrown tap. Core sees only `M-yard-throat` (the
 * zone boundary) and `M-yard-far`. The interior points default to `thru` (an
 * unconditional spine link), so a train passes straight through unless the yard
 * device throws a slot for a service.
 *
 * Built from the SAME primitives the yard uses (`straightSeg`, `cornerSeg`,
 * smooth curves) plus the real `buildYardLayout` network merged in wholesale —
 * its segment ids, `Jw`/`Je` switches and slots preserved. Pure geometry/topology,
 * DOM-free.
 */
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import type { Rail } from './rail.js';
import { cornerSeg } from './railyard-scene.js';
import { type YardLayout, type YardSegGeom, buildYardLayout, straightSeg } from './yard.js';

/* The marker model now lives in the shared `markers.ts` (one source of truth for
 * the bezier + real-piece scenes); imported for local use and re-exported for
 * back-compat (`scene-markers.ts` still imports these from here). */
import type { MarkerEnd, MarkerKind, SceneJunction, SceneMarker } from './markers.js';
export type { MarkerEnd, MarkerKind, SceneJunction, SceneMarker };

/** A loop block: a running-line segment in travel order around a cycle. */
export interface LoopBlock {
  readonly id: string;
  readonly geom: YardSegGeom;
  readonly curved: boolean;
}

/** A running loop the scheduler circulates as a cycle. `main` runs through the
 *  in-line yard; `branch` is an independent scenic ring. */
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
  /** Segment id → world endpoints (loop blocks + yard spine segments). */
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

/* The yard spine world points (from `buildYardLayout` — fixed). The yard spine
 * IS the bottom run of the main loop, so the loop's corners land exactly on these
 * throats, the line running west→east through the spine. */
const YARD_WEST = { x: 150, y: 600 };
const YARD_EAST = { x: 2050, y: 600 };
/* Corner radius — generous, so the loop reads as rounded and a train holds the
 * bend comfortably at running speed (well under the derail limit). */
const R = 320;
const LEFT_X = YARD_WEST.x - R;
const RIGHT_X = YARD_EAST.x + R;
const SPINE_Y = YARD_WEST.y;
/* A tall loop so the left and right straights are LONG — long blocks with room
 * for two markers and a train with separation between them (the original cramped
 * straights starved the dead-reckoning and stalled trains). */
const TOP_Y = -900;
/* Where on the right straight the branch return / spur diverge sit (world y), set
 * so the right run splits into two blocks (`rightA` below the yard corner up to
 * here, `rightB` up to the top corner) — giving a spare block on the long
 * ascending straight so trains pack with separation. */
const REJOIN_Y = SPINE_Y - R - 600;

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

/** Build the MAIN loop's own running blocks (counter-clockwise) and register them
 *  — everything EXCEPT the yard spine, which is merged in by `embedYard` and
 *  spliced between `cSW` and `cSE` so the bottom run passes through the yard. */
function buildMainLoop(segments: Map<string, Rail>, geom: Map<string, YardSegGeom>): LoopBlock[] {
  const blocks: LoopBlock[] = [];
  const s = (id: string, g: YardSegGeom): void => makeStraight(segments, geom, blocks, id, g);
  const c = (id: string, g: YardSegGeom, i: number, o: number): void =>
    makeCorner(segments, geom, blocks, id, g, i, o);
  /* LEFT straight descends (south, 90°) from the top corner to one radius above
   *  the spine; `cSW` curves it EAST onto the yard west throat (`M-yard-throat`).
   *  The spine (`leadW → thru → leadE`) is the bottom run — embedded separately.
   *  `cSE` curves the yard east throat (heading east) round to NORTH; the RIGHT
   *  straight ascends; `Jspur` diverges the branch off `rightB.end`. */
  s('leftA', { ax: LEFT_X, ay: TOP_Y + R, bx: LEFT_X, by: SPINE_Y - R });
  c('cSW', { ax: LEFT_X, ay: SPINE_Y - R, bx: YARD_WEST.x, by: SPINE_Y }, 90, 0);
  /* (yard spine leadW→thru→leadE goes here in travel order) */
  c('cSE', { ax: YARD_EAST.x, ay: SPINE_Y, bx: RIGHT_X, by: SPINE_Y - R }, 0, -90);
  s('rightA', { ax: RIGHT_X, ay: SPINE_Y - R, bx: RIGHT_X, by: REJOIN_Y });
  s('rightB', { ax: RIGHT_X, ay: REJOIN_Y, bx: RIGHT_X, by: TOP_Y + R });
  c('cNE', { ax: RIGHT_X, ay: TOP_Y + R, bx: RIGHT_X - R, by: TOP_Y }, -90, 180);
  s('top', { ax: RIGHT_X - R, ay: TOP_Y, bx: LEFT_X + R, by: TOP_Y });
  c('cNW', { ax: LEFT_X + R, ay: TOP_Y, bx: LEFT_X, by: TOP_Y + R }, 180, 90);
  return blocks;
}

/** Chain the main loop as a CYCLE. The yard spine is in-line on the bottom run, so
 *  the chain is: …cSW → leadW → thru → leadE → cSE… (the three spine links added
 *  by `embedYard`). `rightB` gets a SWITCHED through-link to its corner
 *  (`Jspur=thru`); every other joint is plain. */
function linkMainLoop(yard: YardLayout, links: NetLink[]): void {
  /* The running order around the cycle, splicing the yard spine between cSW and
   *  cSE so the bottom run IS the yard spine. */
  const order = [
    'leftA',
    'cSW',
    yard.leadWest,
    'thru',
    yard.leadEast,
    'cSE',
    'rightA',
    'rightB',
    'cNE',
    'top',
    'cNW',
  ];
  for (let i = 0; i < order.length; i++) {
    const cur = order[i];
    const nxt = order[(i + 1) % order.length];
    if (cur === undefined || nxt === undefined) continue;
    /* leadW→thru and thru→leadE are the yard SPINE: unconditional (default-thru)
     *  joints, so a non-serviced train runs straight through and a slot diversion
     *  (interior `Jw`/`Je` thrown to a slot) overrides them only while servicing.
     *  Those two links are added by `embedYard`; skip them here. */
    if (cur === yard.leadWest || cur === 'thru') continue;
    if (cur === 'rightB') {
      links.push({ from: cur, to: nxt, when: { switchId: 'Jspur', position: 'thru' } });
    } else {
      links.push({ from: cur, to: nxt });
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

/** Rebuild the yard's internal link topology for the IN-LINE spine: the `thru`
 *  spine joints are UNCONDITIONAL (so the default running line goes straight
 *  through the yard, no scheduler tap), and only the slot legs are switched. A
 *  slot diversion (interior `Jw`/`Je` thrown to `slotN`) wins over the
 *  unconditional spine joint while a service is in progress; resetting the points
 *  to anything other than a slot restores the straight-through run. */
function yardLinks(yard: YardLayout, slotCount: number): NetLink[] {
  const links: NetLink[] = [
    { from: yard.leadWest, to: 'thru' },
    { from: 'thru', to: yard.leadEast },
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

/** Merge the embedded yard network IN-LINE: register its segments + geom, its
 *  interior ladder links, and the two SPINE links (`leadW→thru→leadE`) that make
 *  the yard spine the main loop's bottom run. No connector legs and no scheduler
 *  tap — the line runs straight through the yard by default. */
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
  return yard;
}

/** The full core-marker list (in-line yard). Yard interior emits none. */
function sceneMarkers(yard: YardLayout): SceneMarker[] {
  return [
    { id: 'M-top', segment: 'top', end: 'end', kind: 'block_boundary' },
    /* The approach to the yard from the west/top, on the long descending left
     *  straight — a plain block boundary (no junction; the yard is in-line).
     *  M-main-w and M-central are spaced well apart, both clear of the segment
     *  ends (nodes), so a train holds clearance smoothly down the straight. */
    { id: 'M-main-w', segment: 'leftA', end: 'start', distAlongMm: 250, kind: 'block_boundary' },
    { id: 'M-central', segment: 'leftA', end: 'start', distAlongMm: 580, kind: 'station_stop' },
    /* The yard throat: a yard_entry marker ON the running line (zone boundary). */
    { id: 'M-yard-throat', segment: yard.leadWest, end: 'start', kind: 'yard_entry' },
    { id: 'M-yard-far', segment: yard.leadEast, end: 'end', kind: 'block_boundary' },
    /* The ascending right straight, between the yard and the spur. */
    { id: 'M-main-e', segment: 'rightA', end: 'end', kind: 'block_boundary' },
    { id: 'M-spur', segment: 'rightB', end: 'end', kind: 'junction' },
    /* A spare block boundary mid-`top` so the long top run is two blocks, not one
     *  — extra passing capacity so the four trains pack with a clear block between
     *  them and a queue at the yard never backs up into a circular wait. */
    { id: 'M-north', segment: 'top', end: 'start', distAlongMm: 900, kind: 'block_boundary' },
    { id: 'M-branch-top', segment: 'bTop', end: 'end', kind: 'station_stop' },
    { id: 'M-branch-bot', segment: 'bBottom', end: 'start', kind: 'block_boundary' },
  ];
}

/** Build the branching scene. `slotCount` sizes the embedded yard (default 3). */
export function buildBranchingScene(slotCount = 3): BranchingScene {
  const segments = new Map<string, Rail>();
  const geom = new Map<string, YardSegGeom>();
  const links: NetLink[] = [];

  const mainBlocks = buildMainLoop(segments, geom);
  const yard = embedYard(segments, geom, links, slotCount);
  linkMainLoop(yard, links);
  const branchBlocks = buildBranchLoop(segments, geom, links);

  /* The main loop's blocks in travel order, with the yard spine spliced in-line
   *  on the bottom run (between cSW and cSE) so callers that circulate the loop as
   *  a cycle traverse the yard. */
  const spine: LoopBlock[] = [yard.leadWest, 'thru', yard.leadEast].map((id) => {
    const g = geom.get(id);
    if (g === undefined) throw new Error(`branching-scene: no geom for spine ${id}`);
    return { id, geom: g, curved: false };
  });
  const cSWIdx = mainBlocks.findIndex((b) => b.id === 'cSW');
  const mainInline: LoopBlock[] = [
    ...mainBlocks.slice(0, cSWIdx + 1),
    ...spine,
    ...mainBlocks.slice(cSWIdx + 1),
  ];

  const loops: LoopGroup[] = [
    { id: 'main', blocks: mainInline, feedsYard: true },
    { id: 'branch', blocks: branchBlocks, feedsYard: false },
  ];

  const stations: Station[] = [
    {
      id: 'central',
      name: 'CENTRAL',
      x: LEFT_X,
      y: (TOP_Y + R + SPINE_Y - R) / 2,
      angleDeg: 90,
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
    { markerId: 'M-spur', switchId: 'Jspur', positions: ['thru', 'branch'] },
  ];

  return {
    net: buildNetwork(segments, links),
    geom,
    loops,
    stations,
    yard,
    markers: sceneMarkers(yard),
    junctions,
    throatMarker: 'M-yard-throat',
    entrySlot: yard.slots[0] ?? 'slot0',
    sparesSlot: yard.slots[1] ?? 'slot1',
  };
}
