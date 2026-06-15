/**
 * A YARD DETOUR — the parallelogram yard hung off a running line as a true
 * DRIVE-THROUGH, with a BUFFERED LEAD-IN on each side so a serviced train pulls fully
 * clear of the running line before any slow shunting (it never blocks the loop):
 *
 *   running line ──┬─(divert)──▶ lead-in ──▶ yard top lead
 *                  │                              │ (slots)
 *                  └─(bypass, the through line)   ▼
 *   running line ◀─(merge)─── climb-back lead-in ◀── yard bottom lead
 *
 * A train diverts off the line onto the entry lead-in, drives through the yard (top
 * lead → a slot → bottom lead), and the EXIT lead-in carries it back UP to the line
 * (the two yard leads sit a yard-height apart, so the exit lead-in is a climb) and
 * merges it on — leaving by the OTHER side, never reversing onto the line. The main
 * line's own through path (divert → bypass → merge) is the route non-serviced trains
 * take, so the yard sits beside the loop, not in it.
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import { type ParallelogramYardSegments, addParallelogramYard } from './parallelogram-yard.js';
import { type Cursor, PieceNetworkBuilder, type PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
/* The lead-in level + climb curves match the turnout branch radius (241 mm) so they
 *  tile with the yard's turnouts. */
const CURVE: PieceSpec = { type: 'curve', radiusMm: 241 };
const FLIP: PieceSpec = { type: 'curve', flipped: true, radiusMm: 241 };

export interface YardDetourSegments {
  readonly yard: ParallelogramYardSegments;
  /** The divert turnout switch: `main` stays on the loop, `divert` enters the yard. */
  readonly divertSwitch: string;
  readonly mainPos: string;
  readonly divertPos: string;
}

export interface YardDetourOptions {
  readonly prefix: string;
  readonly slots: number;
  readonly slotStraights?: number;
  /** Straights of buffered lead-in between the divert/merge and the yard (so a train
   *  stands fully clear of the running line). */
  readonly leadInStraights?: number;
}

/** The end cursor of a spec run from `from`, measured on a throwaway builder. */
function probeEnd(from: Cursor, specs: readonly PieceSpec[]): Cursor {
  return new PieceNetworkBuilder().run('probe', from, specs);
}

/** A climb-back lead-in `[CURVE, CURVE, straight(L), FLIP, FLIP]` whose straight L is
 *  sized so the run ENDS at `targetY` (the running-line level) — the curves give a
 *  fixed base climb and the straight (vertical mid-climb) trims the rest. */
function climbSpecs(from: Cursor, targetY: number): PieceSpec[] {
  const base = probeEnd(from, [CURVE, CURVE, FLIP, FLIP]).y; // L = 0
  const lengthMm = Math.max(0, base - targetY);
  return lengthMm > 0.5
    ? [CURVE, CURVE, { type: 'straight', lengthMm }, FLIP, FLIP]
    : [CURVE, CURVE, FLIP, FLIP];
}

/**
 * Add a yard detour to `b` from `cursor` on a running line fed by `prevSeg` (heading
 * `cursor.dir`). Lays the divert, the entry lead-in, the parallelogram yard (flipped
 * so it hangs to `cursor.dir`'s +y side), the climb-back exit lead-in, and the merge —
 * plus the bypass filler so the main line carries straight on between divert and merge.
 * Returns the onward cursor (the merged main) and the segment/switch ids.
 */
export function addYardDetour(
  b: PieceNetworkBuilder,
  prevSeg: string,
  cursor: Cursor,
  opts: YardDetourOptions,
): { onward: Cursor; segments: YardDetourSegments } {
  const p = opts.prefix;
  const leadInN = opts.leadInStraights ?? 2;
  const mainPos = 'main';
  const divertPos = 'divert';
  const divertSwitch = `${p}-DIV`;

  /* DIVERT: a facing turnout — through stays on the loop, branch peels off (flipped so
   *  the yard hangs to the +y side). A one-piece inbound stub leads the turnout. */
  const inbound = `${p}-din`;
  const afterIn = b.run(inbound, cursor, [STRAIGHT]);
  b.link(prevSeg, inbound);
  const { thruExit, branchExit } = b.junction(`${p}-dthru`, `${p}-dbr`, afterIn, true);
  b.link(inbound, `${p}-dthru`, { switchId: divertSwitch, position: mainPos });
  b.link(inbound, `${p}-dbr`, { switchId: divertSwitch, position: divertPos });

  /* ENTRY LEAD-IN: level the 45° divert back to the running heading + holding
   *  straights, so a train pulls fully off the line before the yard. */
  const entryLead = `${p}-leadin`;
  const afterLead = b.run(entryLead, branchExit, [
    CURVE,
    ...Array.from({ length: leadInN }, () => STRAIGHT),
  ]);
  b.link(`${p}-dbr`, entryLead);

  /* The yard, hanging below the running line. */
  const yard = addParallelogramYard(b, afterLead, {
    prefix: p,
    slots: opts.slots,
    flipped: true,
    ...(opts.slotStraights !== undefined ? { slotStraights: opts.slotStraights } : {}),
  });
  b.link(entryLead, yard.topLeadIn);

  /* EXIT LEAD-IN: climb the bottom lead back to the running-line level. */
  const climb = `${p}-climb`;
  const bottomOut = yard.segments.bottomLeadOut;
  const afterClimb = b.run(climb, bottomOut, climbSpecs(bottomOut, cursor.y));
  b.link(yard.segments.bottomLeadOutSeg, climb);

  /* MERGE the climbed exit onto the running line; the bypass (the main's own through
   *  line) is filler-sized between the divert through and the merge through. */
  const { trunkExit, thruEntry } = b.mergeJunction(`${p}-mthru`, `${p}-mbr`, afterClimb, false);
  b.link(climb, `${p}-mbr`);
  const dist = Math.hypot(thruEntry.x - thruExit.x, thruEntry.y - thruExit.y);
  const full = Math.floor(dist / 200 + 1e-6);
  const filler = dist - full * 200;
  const bypassSpecs: PieceSpec[] = Array.from({ length: full }, () => STRAIGHT);
  if (filler > 0.5) bypassSpecs.push({ type: 'straight', lengthMm: filler });
  const bypass = `${p}-bypass`;
  b.run(bypass, thruExit, bypassSpecs.length > 0 ? bypassSpecs : [STRAIGHT]);
  b.link(`${p}-dthru`, bypass);
  b.link(bypass, `${p}-mthru`);

  return {
    onward: trunkExit,
    segments: {
      yard: yard.segments,
      divertSwitch,
      mainPos,
      divertPos,
    },
  };
}

export type { ParallelogramYardSegments };
