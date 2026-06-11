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
  exit(seg: string, end: SegEnd, switches: ReadonlyMap<string, string>): NetExit | null;
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
   *  else the first unconditional one, else undefined. */
  const active = (
    candidates: NetLink[],
    switches: ReadonlyMap<string, string>,
  ): NetLink | undefined => {
    const matched = candidates.find(
      (l) => l.when !== undefined && switches.get(l.when.switchId) === l.when.position,
    );
    if (matched !== undefined) return matched;
    return candidates.find((l) => l.when === undefined);
  };
  return {
    railOf,
    segments: () => [...segments.keys()],
    exit(seg, end, switches): NetExit | null {
      if (end === 'end') {
        // Forward: links leaving this segment's end.
        const link = active(
          links.filter((l) => l.from === seg),
          switches,
        );
        return link
          ? { seg: link.to, atDist: 0, dir: 1, flipsFacing: link.flipsFacing ?? false }
          : null;
      }
      // Reverse off the start: the segment whose (active) forward link feeds it.
      const link = active(
        links.filter((l) => l.to === seg),
        switches,
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
