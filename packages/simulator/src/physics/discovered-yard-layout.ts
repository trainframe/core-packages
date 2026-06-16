/**
 * Adapts an ARBITRARY fan of DISCOVERED slot segments — the operator's real stabling
 * roads, found beneath a gantry footprint by `discoverYardSlots` — to the `YardLayout`
 * seam the reused `YardController` drives. It is the general sibling of
 * `parallelogram-yard-layout.ts`: where that projects a yard the BUILDER laid (so the
 * slot/lead/switch ids are known up front), this RE-DISCOVERS that structure from a
 * network it was handed nothing about but the slot segments — the leads, the throat and
 * the ladder switches are all inferred from the SAME `compileNetwork` net's adjacency.
 *
 * The whole point of the toybox keystone: the gantry drives the operator's ACTUAL
 * segments in the ONE unified network (a running loop + the slots, both already in
 * `compileNetwork(pieces).net`). No synthetic interior, no translation, no second world.
 *
 * ── What it infers ──────────────────────────────────────────────────────────
 *  - SLOT ROADS: discovery returns one segment per piece, so a multi-piece stabling
 *    road arrives as several collinear, end-to-end segments. They are COALESCED into
 *    roads; each road becomes ONE `YardLayout` slot whose geom spans the whole road
 *    (mouth → foot), driven on the net's own rails (the controller throws points and
 *    reads the camera; the world's links carry the train across the road's segments).
 *  - LEADS: each road's two ends front onto NON-slot track (the throat leads). The end
 *    nearer the network's WEST is the entry (`leadWest`); the far end the exit
 *    (`leadEast`). One representative lead segment is chosen per side.
 *  - LADDER SWITCHES: a road fed at an end through a JUNCTION leg (`S-X` / `S-X-b` in
 *    the compiled net) is selected by throwing switch `M-X` — `divert` for the branch
 *    leg, `main` for the through. A road fronting plain track (a trailing road reached
 *    by a curve) carries no switch on that side. The per-slot, per-side throws are
 *    returned as a `ladder` the COMPOSITION binds two `SwitchActuator`s to (exactly as
 *    the parallelogram yard binds `ladderSwitchActuator`); the controller, which thinks
 *    in a single multi-position diverge/converge switch, is none the wiser.
 *
 * Pure geometry/topology: endpoints come straight from the net's `geom`. No DOM, no
 * clock, no randomness.
 */
import type { RailNetwork } from './network.js';
import type { SegEndpoints } from './piece-network.js';
import type { YardLayout, YardSegGeom } from './yard.js';

/** Nominal switch labels the controller addresses (the bound actuators are ladder
 *  composites translating `set(slotId)` into real junction throws, not these ids). */
export const DISCOVERED_WEST_SWITCH = 'west-ladder';
export const DISCOVERED_EAST_SWITCH = 'east-ladder';

/** How near two world endpoints must be to count as the same joint — the same snap the
 *  compilers use. */
const SNAP_MM = 30;
/** How parallel two segments must be (degrees) to belong to the same straight road. */
const COLINEAR_TOLERANCE_DEG = 8;

export interface DiscoveredYardOptions {
  /** The compiled switch ids that are real junctions in `net` — `M-{pieceId}`. A slot
   *  fed through one of these is gated by it. (The compiled junction segments are
   *  `S-{pieceId}` / `S-{pieceId}-b`; this is how the adapter learns which segment id
   *  belongs to which switch.) */
  readonly junctionSwitchIds: readonly string[];
}

/** A single junction throw: set `switchId` to `position` to route through that leg. */
export interface LadderThrow {
  readonly switchId: string;
  readonly position: string;
}

/** Per-slot ladder throws — what to set on each side to route a lead into THAT slot.
 *  `null` means the slot fronts plain track on that side (no switch). */
export interface SlotLadder {
  readonly slot: string;
  readonly west: LadderThrow | null;
  readonly east: LadderThrow | null;
}

export interface DiscoveredYard {
  readonly layout: YardLayout;
  /** Per-slot, per-side throws the composition binds the two `SwitchActuator`s to. */
  readonly ladder: readonly SlotLadder[];
  /** Where a visitor parks at the throat — the entry lead's outer end. */
  readonly throatPoint: { x: number; y: number };
}

/** The undirected angle [0,180) of a segment. */
function angleOf(e: SegEndpoints): number {
  const a = (Math.atan2(e.end.y - e.start.y, e.end.x - e.start.x) * 180) / Math.PI;
  return ((a % 180) + 180) % 180;
}

function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

function near(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.hypot(ax - bx, ay - by) <= SNAP_MM;
}

/** Whether two segments share an endpoint within snap. */
function touch(a: SegEndpoints, b: SegEndpoints): boolean {
  return (
    near(a.start.x, a.start.y, b.start.x, b.start.y) ||
    near(a.start.x, a.start.y, b.end.x, b.end.y) ||
    near(a.end.x, a.end.y, b.start.x, b.start.y) ||
    near(a.end.x, a.end.y, b.end.x, b.end.y)
  );
}

/** A road: an ordered chain of collinear, end-to-end slot segments, with its two
 *  extreme world endpoints (`a` / `b`). */
interface Road {
  readonly segs: string[];
  readonly a: { x: number; y: number };
  readonly b: { x: number; y: number };
}

/** A tiny string union-find for grouping collinear, touching segments into roads. */
class UnionFind {
  private readonly parent = new Map<string, string>();
  add(s: string): void {
    if (!this.parent.has(s)) this.parent.set(s, s);
  }
  find(s: string): string {
    let r = s;
    while (this.parent.get(r) !== r) r = this.parent.get(r) ?? r;
    return r;
  }
  union(x: string, y: string): void {
    this.parent.set(this.find(x), this.find(y));
  }
}

/** Whether two segments are collinear AND meet end-to-end — i.e. they are the same road. */
function sameRoad(a: SegEndpoints, b: SegEndpoints): boolean {
  return angleGap(angleOf(a), angleOf(b)) <= COLINEAR_TOLERANCE_DEG && touch(a, b);
}

/** A discovered slot segment paired with its (guaranteed-present) endpoints. */
interface SlotSeg {
  readonly id: string;
  readonly g: SegEndpoints;
}

/** Union every pair of segments that share a road (collinear + touching). */
function unionCollinear(slots: readonly SlotSeg[], uf: UnionFind): void {
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < slots.length; j++) {
      const b = slots[j];
      if (b !== undefined && sameRoad(a.g, b.g)) uf.union(a.id, b.id);
    }
  }
}

/** Group segment ids by their union-find root — each group is one road's segments. */
function groupByRoot(ids: readonly string[], uf: UnionFind): string[][] {
  const byRoot = new Map<string, string[]>();
  for (const id of ids) {
    const root = uf.find(id);
    const arr = byRoot.get(root) ?? [];
    arr.push(id);
    byRoot.set(root, arr);
  }
  return [...byRoot.values()];
}

/** Coalesce the discovered slot segments into ROADS: collinear segments joined
 *  end-to-end are one stabling road. Single-segment slots stay single roads. */
function coalesceRoads(
  slotSegs: readonly string[],
  geom: ReadonlyMap<string, SegEndpoints>,
): Road[] {
  const slots: SlotSeg[] = [];
  for (const id of slotSegs) {
    const g = geom.get(id);
    if (g !== undefined) slots.push({ id, g });
  }
  const uf = new UnionFind();
  for (const s of slots) uf.add(s.id);
  unionCollinear(slots, uf);
  return groupByRoot(
    slots.map((s) => s.id),
    uf,
  ).map((members) => roadFromSegs(members, geom));
}

/** The two extreme endpoints of a chain of collinear segments — the pair of world
 *  points farthest apart among all the segments' endpoints. */
function roadFromSegs(segs: string[], geom: ReadonlyMap<string, SegEndpoints>): Road {
  const pts: { x: number; y: number }[] = [];
  for (const s of segs) {
    const g = geom.get(s);
    if (g === undefined) continue;
    pts.push(g.start, g.end);
  }
  let a = pts[0] ?? { x: 0, y: 0 };
  let b = pts[0] ?? { x: 0, y: 0 };
  let best = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const pi = pts[i];
      const pj = pts[j];
      if (pi === undefined || pj === undefined) continue;
      const d = Math.hypot(pi.x - pj.x, pi.y - pj.y);
      if (d > best) {
        best = d;
        a = pi;
        b = pj;
      }
    }
  }
  return { segs, a, b };
}

/** The junction throw a compiled segment represents, or null when it isn't a junction
 *  leg. `S-{id}-b` → branch (`divert`); `S-{id}` whose `M-{id}` is a junction → through
 *  (`main`). */
function switchForSegment(seg: string, junctionSwitchIds: ReadonlySet<string>): LadderThrow | null {
  if (!seg.startsWith('S-')) return null;
  const isBranch = seg.endsWith('-b');
  const pieceId = isBranch ? seg.slice(2, -2) : seg.slice(2);
  const switchId = `M-${pieceId}`;
  if (!junctionSwitchIds.has(switchId)) return null;
  return { switchId, position: isBranch ? 'divert' : 'main' };
}

/** A full-length running straight (mm) — what a yard LEAD is, as opposed to the short
 *  curves / junction-branch legs (≤ ~185 mm) that connect a slot to its lead. */
const LEAD_MIN_LENGTH_MM = 190;

/** Whether a segment touches a world point at either end (within snap). */
function segTouches(g: SegEndpoints, p: { x: number; y: number }): boolean {
  return near(g.start.x, g.start.y, p.x, p.y) || near(g.end.x, g.end.y, p.x, p.y);
}

/** The endpoint of `g` FARTHER from `p` — where a connector carries on, away from `p`. */
function farEndOf(g: SegEndpoints, p: { x: number; y: number }): { x: number; y: number } {
  const ds = Math.hypot(g.start.x - p.x, g.start.y - p.y);
  const de = Math.hypot(g.end.x - p.x, g.end.y - p.y);
  return ds >= de ? g.start : g.end;
}

function lengthOf(g: SegEndpoints): number {
  return Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
}

/** Walk OUTWARD from a slot road's end at world point `p`, through the yard's internal
 *  connectors (junction legs + the short curves between a slot and its lead), to the
 *  LEAD: the first full-length running straight reached that is neither a slot nor a
 *  junction leg — the running line the gantry's fan fronts. Records the FIRST junction
 *  crossed — that is the ladder switch selecting this slot on this side. Returns the lead
 *  segment, its outer (running-line) world point, and the throw, or null when the end
 *  fronts no running line within a bounded walk. */
interface SideResolution {
  readonly lead: string;
  readonly outer: { x: number; y: number };
  readonly throw: LadderThrow | null;
}

/** One BFS frontier node: a world point reached, and the first junction throw crossed to
 *  get there (the ladder switch that will route this slot from this side). */
interface WalkNode {
  readonly at: { x: number; y: number };
  readonly throw: LadderThrow | null;
}

/** Expand one frontier node across the net: for each not-yet-seen segment touching it,
 *  either RETURN it as the lead (a full-length running straight that is no junction leg),
 *  or enqueue its far end onto `next` to keep walking. */
function stepWalk(
  node: WalkNode,
  ctx: {
    net: RailNetwork;
    geom: ReadonlyMap<string, SegEndpoints>;
    junctionSwitchIds: ReadonlySet<string>;
    seen: Set<string>;
  },
  next: WalkNode[],
): SideResolution | null {
  for (const seg of ctx.net.segments()) {
    if (ctx.seen.has(seg)) continue;
    const g = ctx.geom.get(seg);
    if (g === undefined || !segTouches(g, node.at)) continue;
    ctx.seen.add(seg);
    const far = farEndOf(g, node.at);
    const legThrow = switchForSegment(seg, ctx.junctionSwitchIds);
    if (legThrow === null && lengthOf(g) >= LEAD_MIN_LENGTH_MM) {
      return { lead: seg, outer: far, throw: node.throw };
    }
    next.push({ at: far, throw: legThrow ?? node.throw });
  }
  return null;
}

/** Walk OUTWARD from a slot road's end at world point `p`, through the yard's internal
 *  connectors (junction legs + the short curves between a slot and its lead), to the
 *  LEAD: the first full-length running straight reached that is neither a slot nor a
 *  junction leg — the running line the gantry's fan fronts. Records the FIRST junction
 *  crossed — the ladder switch selecting this slot on this side. Null when the end fronts
 *  no running line within a bounded walk. */
function walkToLead(
  p: { x: number; y: number },
  slotSegs: ReadonlySet<string>,
  net: RailNetwork,
  geom: ReadonlyMap<string, SegEndpoints>,
  junctionSwitchIds: ReadonlySet<string>,
): SideResolution | null {
  const ctx = { net, geom, junctionSwitchIds, seen: new Set<string>(slotSegs) };
  let frontier: WalkNode[] = [{ at: p, throw: null }];
  for (let depth = 0; depth < 12 && frontier.length > 0; depth++) {
    const next: WalkNode[] = [];
    for (const node of frontier) {
      const lead = stepWalk(node, ctx, next);
      if (lead !== null) return lead;
    }
    frontier = next;
  }
  return null;
}

/** A road resolved into its two sides — each fronting a running-line lead (with the
 *  throw that routes into the slot from that side). */
interface ResolvedRoad {
  readonly slot: string;
  readonly geom: YardSegGeom;
  /** The two ends, each resolved to a lead (or null when it fronts no running line). */
  readonly endA: SideResolution | null;
  readonly endB: SideResolution | null;
  readonly a: { x: number; y: number };
  readonly b: { x: number; y: number };
}

function resolveRoad(
  road: Road,
  net: RailNetwork,
  geom: ReadonlyMap<string, SegEndpoints>,
  junctionSwitchIds: ReadonlySet<string>,
): ResolvedRoad {
  const roadSet = new Set(road.segs);
  return {
    slot: road.segs[0] ?? '',
    geom: { ax: road.a.x, ay: road.a.y, bx: road.b.x, by: road.b.y },
    endA: walkToLead(road.a, roadSet, net, geom, junctionSwitchIds),
    endB: walkToLead(road.b, roadSet, net, geom, junctionSwitchIds),
    a: road.a,
    b: road.b,
  };
}

/**
 * Build a `YardController`-ready `YardLayout` over an arbitrary fan of discovered slot
 * segments in the operator's compiled `net`. Returns the layout, the per-slot ladder
 * throws (the composition binds two actuators to them), and the throat parking point —
 * or `null` when fewer than two roads coalesce (no fan = the gantry stalls), or the fan
 * fronts no two distinct running-line leads.
 */
export function discoveredYardLayout(
  net: RailNetwork,
  geom: ReadonlyMap<string, SegEndpoints>,
  slotSegIds: readonly string[],
  opts: DiscoveredYardOptions,
): DiscoveredYard | null {
  const switchSet = new Set(opts.junctionSwitchIds);
  /* A junction LEG (`S-X` / `S-X-b`) that fell under the footprint is a CONNECTOR feeding
   *  a slot, never a stabling road itself — drop it before coalescing so a slot is only
   *  ever real running track, not a turnout's through/branch rail. */
  const slotSegsOnly = slotSegIds.filter((s) => switchForSegment(s, switchSet) === null);
  const roads = coalesceRoads(slotSegsOnly, geom);
  if (roads.length < 2) return null;

  const resolved = roads.map((r) => resolveRoad(r, net, geom, switchSet));
  const leads = pickLeads(resolved);
  if (leads === null) return null;

  const layoutGeom = new Map<string, YardSegGeom>();
  const ladder: SlotLadder[] = [];
  const slots: string[] = [];
  for (const r of resolved) buildSlot(r, leads.west, leads.east, layoutGeom, ladder, slots);
  setLeadGeom(layoutGeom, geom, leads.west);
  setLeadGeom(layoutGeom, geom, leads.east);

  const layout: YardLayout = {
    net,
    geom: layoutGeom,
    leadWest: leads.west,
    leadEast: leads.east,
    slots,
    westSwitch: DISCOVERED_WEST_SWITCH,
    eastSwitch: DISCOVERED_EAST_SWITCH,
  };
  return { layout, ladder, throatPoint: leads.throat };
}

/** The two LEADS the fan fronts: tally the running-line leads each road's two ends walk
 *  out to and pick the two most common as `west` (entry) / `east` (exit), with the entry
 *  lead's outer point as the throat. Null when fewer than two distinct leads are found. */
function pickLeads(
  resolved: readonly ResolvedRoad[],
): { west: string; east: string; throat: { x: number; y: number } } | null {
  const tally = new Map<string, { count: number; outer: { x: number; y: number } }>();
  for (const r of resolved) {
    for (const side of [r.endA, r.endB]) {
      if (side === null) continue;
      const t = tally.get(side.lead) ?? { count: 0, outer: side.outer };
      t.count += 1;
      tally.set(side.lead, t);
    }
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
  const west = ranked[0];
  const east = ranked[1];
  if (west === undefined || east === undefined) return null;
  return { west: west[0], east: east[0], throat: west[1].outer };
}

/** Build one slot's geom + ladder entry. The controller enters at the slot MOUTH (geom
 *  `a`) and rests at the far FOOT (geom `b`), reasoning FOOT→MOUTH; the visitor arrives
 *  along leadWest, so the ENTRY (leadWest) end is the MOUTH `a` and the EXIT (leadEast)
 *  end — where it pulls clear and reverses onto the spares — is the FOOT `b`. */
function buildSlot(
  r: ResolvedRoad,
  leadWestSeg: string,
  leadEastSeg: string,
  layoutGeom: Map<string, YardSegGeom>,
  ladder: SlotLadder[],
  slots: string[],
): void {
  const entrySide = sideFronting(r, leadWestSeg);
  const exitSide = sideFronting(r, leadEastSeg);
  const entryEnd = entrySide === 'a' ? r.a : r.b;
  const exitEnd = exitSide === 'a' ? r.a : r.b;
  layoutGeom.set(r.slot, { ax: entryEnd.x, ay: entryEnd.y, bx: exitEnd.x, by: exitEnd.y });
  slots.push(r.slot);
  ladder.push({
    slot: r.slot,
    west: (entrySide === 'a' ? r.endA : r.endB)?.throw ?? null,
    east: (exitSide === 'a' ? r.endA : r.endB)?.throw ?? null,
  });
}

/** Which of a road's ends (`a` / `b`) fronts lead `leadSeg` — the one whose walk landed
 *  on it (defaulting to `b` when neither does, so the geometry stays well-formed). */
function sideFronting(r: ResolvedRoad, leadSeg: string): 'a' | 'b' {
  if (r.endA?.lead === leadSeg) return 'a';
  if (r.endB?.lead === leadSeg) return 'b';
  /* Neither end resolved to this lead (a slot fronting it only on its other side): keep
   *  the geometry consistent by picking the end NOT used for the opposite lead. */
  return r.endA === null ? 'a' : 'b';
}

/** Record a lead segment's world endpoints into the layout geom. */
function setLeadGeom(
  layoutGeom: Map<string, YardSegGeom>,
  geom: ReadonlyMap<string, SegEndpoints>,
  leadSeg: string,
): void {
  const g = geom.get(leadSeg);
  if (g !== undefined)
    layoutGeom.set(leadSeg, { ax: g.start.x, ay: g.start.y, bx: g.end.x, by: g.end.y });
}
