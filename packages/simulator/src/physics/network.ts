/**
 * A rail NETWORK: several `Rail` segments joined at nodes, with junctions whose
 * SWITCH position picks the active branch (ADR-030 — to the physics a junction is
 * ordinary track; only the chosen branch differs). A body drives along a segment
 * and, on reaching an end, transitions to the connected segment per the live
 * switch positions — in either direction (forward off a segment's end, or in
 * reverse off its start).
 *
 * Orientation convention: every link is directed `from.end → to.start`, so a
 * forward transition always enters the next segment at its start and a reverse
 * one re-enters the previous segment at its end — velocity and facing carry over
 * unchanged. The world owns the switch positions and asks the network where a
 * body goes next. A single rail is the trivial one-segment network.
 *
 * Pure geometry/topology, DOM-free.
 */
import type { Rail } from './rail.js';

export type SegEnd = 'start' | 'end';

/** Where a transitioning body lands: the segment, the distance along it to start
 *  from, and the travel direction (+1 entering at start, -1 entering at end).
 *  `flipsFacing` is true when the link the body crossed turns it around (a
 *  turntable deck rotated 180°): the body keeps its world travel direction but
 *  comes off the link facing the other way. */
export interface NetExit {
  readonly seg: string;
  readonly atDist: number;
  readonly dir: 1 | -1;
  readonly flipsFacing: boolean;
}

export interface RailNetwork {
  railOf(seg: string): Rail;
  segments(): readonly string[];
  /** Where a body leaving `seg` at `end` goes next given the live switch
   *  positions, or null when nothing is connected (the rail's own buffer/run-off
   *  applies). */
  exit(
    seg: string,
    end: SegEnd,
    switches: ReadonlyMap<string, string>,
    activeLinks?: ReadonlyMap<string, boolean>,
  ): NetExit | null;
}

/** The trivial one-segment network around a single rail (segment id `main`,
 *  nothing connected) — lets the world treat single-rail and network alike. */
export function singleRail(rail: Rail): RailNetwork {
  return {
    railOf: () => rail,
    segments: () => ['main'],
    exit: () => null,
  };
}

/** Whether a link is connected RIGHT NOW. A link with no `id`, or one absent
 *  from the `activeLinks` map, is connected (the default — backwards-compatible
 *  with every static link). A link whose id maps to `false` is DISCONNECTED: the
 *  rail it represents is physically absent (a raised lift-bridge span), so the
 *  network treats it as not there and a body meets the rail end's buffer/run-off. */
function linkConnected(link: NetLink, activeLinks: ReadonlyMap<string, boolean>): boolean {
  if (link.id === undefined) return true;
  return activeLinks.get(link.id) !== false;
}

/** A directed link `from.end → to.start`. When `when` is set the link is active
 *  only while that switch is in that position (a junction branch); an
 *  unconditional link is always active (a plain joint). `flipsFacing` marks a
 *  TURN-AROUND link — a body crossing it reverses its facing (the turntable deck
 *  swung 180°), keeping its world travel direction. */
export interface NetLink {
  readonly from: string;
  readonly to: string;
  readonly when?: { readonly switchId: string; readonly position: string };
  readonly flipsFacing?: boolean;
  /** A stable id by which the world can DISCONNECT this link at runtime (a
   *  lift-bridge span raising breaks the rail). When set and the world has marked
   *  it inactive, the link is treated as absent. Unset → always connected. */
  readonly id?: string;
}

/** Build a network from named rail segments + directed links. */
export function buildNetwork(
  segments: ReadonlyMap<string, Rail>,
  links: ReadonlyArray<NetLink>,
): RailNetwork {
  const railOf = (seg: string): Rail => {
    const r = segments.get(seg);
    if (r === undefined) throw new Error(`network: no segment ${seg}`);
    return r;
  };
  /** The currently-active link among `candidates`: a switch-matched one if any,
   *  else the first unconditional one, else — when a single switch-gated link is
   *  the ONLY way on — that one regardless of the switch (a TRAILING-POINT merge,
   *  below), else undefined. A DISCONNECTED link (its id marked inactive — a raised
   *  span) is filtered out first, so it never wins selection: the body then meets
   *  the rail end as if nothing were connected. */
  const active = (
    candidates: NetLink[],
    switches: ReadonlyMap<string, string>,
    activeLinks: ReadonlyMap<string, boolean>,
  ): NetLink | undefined => {
    const connected = candidates.filter((l) => linkConnected(l, activeLinks));
    const matched = connected.find(
      (l) => l.when !== undefined && switches.get(l.when.switchId) === l.when.position,
    );
    if (matched !== undefined) return matched;
    const unconditional = connected.find((l) => l.when === undefined);
    if (unconditional !== undefined) return unconditional;
    /* TRAILING POINT: a single connected link with no alternative is a merge —
     *  the body arrives on a leg with only the trunk ahead, so it trails THROUGH
     *  regardless of the switch position (a real trailing point yields). Only a
     *  FACING move, which presents two+ legs to choose between, gates on the
     *  switch (and so returns undefined above when none matches). */
    return connected.length === 1 ? connected[0] : undefined;
  };
  const NONE: ReadonlyMap<string, boolean> = new Map();
  return {
    railOf,
    segments: () => [...segments.keys()],
    exit(seg, end, switches, activeLinks = NONE): NetExit | null {
      if (end === 'end') {
        // Forward: links leaving this segment's end.
        const link = active(
          links.filter((l) => l.from === seg),
          switches,
          activeLinks,
        );
        return link
          ? { seg: link.to, atDist: 0, dir: 1, flipsFacing: link.flipsFacing ?? false }
          : null;
      }
      // Reverse off the start: the segment whose (active) forward link feeds it.
      const link = active(
        links.filter((l) => l.to === seg),
        switches,
        activeLinks,
      );
      return link
        ? {
            seg: link.from,
            atDist: railOf(link.from).length,
            dir: -1,
            flipsFacing: link.flipsFacing ?? false,
          }
        : null;
    },
  };
}
