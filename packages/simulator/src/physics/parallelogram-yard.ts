/**
 * A PARALLELOGRAM railyard from real pieces — a DRIVE-THROUGH stabling fan whose
 * SLOTS are parallel 45° diagonals strung between a TOP lead and a BOTTOM lead.
 *
 *     in ╲
 *         ╰──┬────┬────┬────╮     top lead — facing turnouts into the inner slots,
 *          ╲  ╲    ╲    ╲    ╲     and a plain CURVE into the trailing slot (no switch)
 *           ╲  ╲    ╲    ╲    ╲    the slots: parallel diagonal roads
 *         ╭──┴────┴────┴────╯
 *      out╯  bottom lead — a plain CURVE off the leading slot (no switch), then
 *            trailing turnouts up the inner slots
 *
 * Each lead is just the run between the OUTER slots: the top lead curves into the
 * TRAILING slot and the bottom lead curves off the LEADING slot — the two outer
 * corners are plain curves, since a train that reaches the end of a lead has only one
 * place to go (no switch needed). Inner slots carry a turnout on each lead. The yard
 * has NO inherent direction: either lead can be the way in or out (the wider layout +
 * operator decide). A train drives in on one lead, a turnout (or the end curve) drops
 * it into a slot to stable, and it leaves by the other lead. `slots` is configurable.
 *
 * Built on the Brio/IKEA 45°/200 mm grid, so it closes by construction and an
 * accidental same-layer overlap is a build-time error. Pure geometry/topology: no
 * DOM, no clock, no randomness.
 */
import type { Cursor, PieceNetworkBuilder, PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
/* The outer-corner curves match a TURNOUT's 45° branch radius (241 mm, not the plain
 *  curve's 200 mm) so they land exactly where the inner slots' junction branches do —
 *  otherwise a 200 mm curve leaves a ~12 mm jog against the merge-built bottom lead. */
const TURNOUT_BRANCH_RADIUS_MM = 241;
const CURVE: PieceSpec = { type: 'curve', radiusMm: TURNOUT_BRANCH_RADIUS_MM };
const FLIP: PieceSpec = { type: 'curve', flipped: true, radiusMm: TURNOUT_BRANCH_RADIUS_MM };

function side(n: number): PieceSpec[] {
  return Array.from({ length: n }, () => STRAIGHT);
}

export interface ParallelogramYardSegments {
  /** The diagonal slot segment ids (leading → trailing), where stock stables. */
  readonly slots: readonly string[];
  /** Top-lead switch id per slot, or `undefined` for the trailing slot (a plain
   *  curve). `thru` stays on the lead, `slot` drops into the slot. */
  readonly topSwitches: readonly (string | undefined)[];
  /** Bottom-lead switch id per slot, or `undefined` for the leading slot (a plain
   *  curve). The yard is directionless: a train entering the BOTTOM lead diverts up a
   *  slot when its bottom switch is `slot`. */
  readonly bottomSwitches: readonly (string | undefined)[];
  readonly thruPos: string;
  readonly slotPos: string;
  /** The top lead's entry stub (the caller links its inbound run here). */
  readonly topLeadIn: string;
  /** The bottom lead's exit cursor (where the running line carries on). */
  readonly bottomLeadOut: Cursor;
  /** The bottom lead's last segment (the caller links the onward run from here). */
  readonly bottomLeadOutSeg: string;
}

export interface ParallelogramYardOptions {
  readonly prefix: string;
  /** Number of parallel diagonal slots. */
  readonly slots: number;
  /** Which side the slots fan toward. `false` (default) drops them to screen-+y for an
   *  EAST-heading entry; `true` mirrors it, so a WEST-heading entry still fans the slots
   *  to +y (the yard hangs BELOW a westbound run rather than above it). */
  readonly flipped?: boolean;
  /** Straights along each diagonal slot (its stabling length). */
  readonly slotStraights?: number;
  /** Straights of top-lead between adjacent slot turnouts (the slot stagger). */
  readonly leadStraights?: number;
}

/** A bottom-lead node (a slot's foot) feeding the lead: its trunk cursor where the
 *  lead carries on, and a `feed` that links the node's output leg(s) onto the next
 *  lead segment (a plain link off the leading curve, or two switch-gated legs off a
 *  merge). */
interface BottomNode {
  readonly trunk: Cursor;
  readonly feed: (leadId: string) => void;
}

/** A filler-sized straight run from `from` toward `target` (or a single straight when
 *  `target` is null — the lead-out stub). Returns its end cursor. */
function runLead(b: PieceNetworkBuilder, id: string, from: Cursor, target: Cursor | null): Cursor {
  let specs: PieceSpec[] = [STRAIGHT];
  if (target !== null) {
    const dist = Math.hypot(target.x - from.x, target.y - from.y);
    const full = Math.floor(dist / 200 + 1e-6);
    const filler = dist - full * 200;
    specs = side(full);
    if (filler > 0.5) specs.push({ type: 'straight', lengthMm: filler });
    if (specs.length === 0) specs = [STRAIGHT];
  }
  return b.run(id, from, specs);
}

/**
 * Add a parallelogram yard to `b` from `entry` (heading along `entry.dir` — the top
 * lead's direction). Lays the top-lead ladder (facing turnouts into the inner slots,
 * a curve into the trailing slot), the parallel diagonal slots, and the bottom-lead
 * chain (a curve off the leading slot, trailing turnouts up the inner slots). Wires
 * all internal links; the caller links its inbound run → `topLeadIn` and the onward
 * run ← `bottomLeadOutSeg`. Returns the segment/switch ids.
 */
export function addParallelogramYard(
  b: PieceNetworkBuilder,
  entry: Cursor,
  opts: ParallelogramYardOptions,
): { segments: ParallelogramYardSegments; topLeadIn: string } {
  const p = opts.prefix;
  const slotStraights = opts.slotStraights ?? 3;
  const leadStraights = opts.leadStraights ?? 1;
  const thruPos = 'thru';
  const slotPos = 'slot';
  const last = opts.slots - 1;
  const flip = opts.flipped ?? false;
  /* The two corner curves mirror with the turnouts when flipped, so the whole yard
   *  fans to the same side as the slot branches. */
  const topCorner = flip ? FLIP : CURVE;
  const botCorner = flip ? CURVE : FLIP;

  const topLeadIn = `${p}-topin`;
  let topCursor = b.run(topLeadIn, entry, [STRAIGHT]);
  let prevTopSeg = topLeadIn;

  const slots: string[] = [];
  const topSwitches: (string | undefined)[] = [];
  const bottomSwitches: (string | undefined)[] = [];
  let prev: BottomNode | null = null;
  let bottomLeadOutSeg = '';
  let bottomLeadOut: Cursor = entry;

  for (let i = 0; i < opts.slots; i++) {
    const slot = `${p}-slot${i}`;

    /* TOP: a facing turnout into each inner slot; the trailing slot is reached by the
     *  top lead simply CURVING into it (the lead ends — no choice, no switch). */
    let slotMouth: Cursor;
    let slotFeed: string;
    if (i === last) {
      const tc = `${p}-topcurve`;
      slotMouth = b.run(tc, topCursor, [topCorner]);
      b.link(prevTopSeg, tc);
      slotFeed = tc;
      topSwitches.push(undefined);
    } else {
      const sw = `${p}-sw${i}`;
      const topThru = `${p}-tt${i}`;
      const topBranch = `${p}-tb${i}`;
      const { thruExit, branchExit } = b.junction(topThru, topBranch, topCursor, flip);
      b.link(prevTopSeg, topThru, { switchId: sw, position: thruPos });
      b.link(prevTopSeg, topBranch, { switchId: sw, position: slotPos });
      slotMouth = branchExit;
      slotFeed = topBranch;
      topSwitches.push(sw);
      const gap = `${p}-tg${i}`;
      topCursor = b.run(gap, thruExit, side(leadStraights));
      b.link(topThru, gap);
      prevTopSeg = gap;
    }

    /* The diagonal slot — a straight run at 45°, where stock stables. */
    const slotEnd = b.run(slot, slotMouth, side(slotStraights));
    b.link(slotFeed, slot);
    slots.push(slot);

    /* BOTTOM: the leading slot CURVES onto the bottom lead (the lead starts — no
     *  switch); every inner slot converges via a trailing turnout. */
    if (i === 0) {
      const bc = `${p}-botcurve`;
      const bcEnd = b.run(bc, slotEnd, [botCorner]);
      b.link(slot, bc);
      prev = { trunk: bcEnd, feed: (leadId) => b.link(bc, leadId) };
      bottomSwitches.push(undefined);
    } else {
      const botSw = `${p}-bsw${i}`;
      const botThru = `${p}-bt${i}`;
      const botBranch = `${p}-bb${i}`;
      const { trunkExit, thruEntry } = b.mergeJunction(botThru, botBranch, slotEnd, flip);
      b.link(slot, botBranch);
      if (prev !== null) {
        const lead = `${p}-lead${i}`;
        runLead(b, lead, prev.trunk, thruEntry);
        prev.feed(lead);
        b.link(lead, botThru);
      }
      prev = {
        trunk: trunkExit,
        feed: (leadId) => {
          b.link(botThru, leadId, { switchId: botSw, position: thruPos });
          b.link(botBranch, leadId, { switchId: botSw, position: slotPos });
        },
      };
      bottomSwitches.push(botSw);
    }
  }

  /* The lead-out: a final bottom-lead stub the trailing node feeds. */
  if (prev !== null) {
    const out = `${p}-leadout`;
    bottomLeadOut = runLead(b, out, prev.trunk, null);
    prev.feed(out);
    bottomLeadOutSeg = out;
  }

  return {
    topLeadIn,
    segments: {
      slots,
      topSwitches,
      bottomSwitches,
      thruPos,
      slotPos,
      topLeadIn,
      bottomLeadOut,
      bottomLeadOutSeg,
    },
  };
}
