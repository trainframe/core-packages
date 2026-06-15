/**
 * A PARALLELOGRAM railyard from real pieces — a DRIVE-THROUGH stabling fan whose
 * SLOTS are parallel 45° diagonals strung between a TOP lead and a BOTTOM lead.
 *
 *     in ╲
 *         ●━━━━┳━━━━┳━━━━┳━━━━┳━━━━●     top lead (facing turnouts into each slot)
 *          ╲    ╲    ╲    ╲    ╲    ╲
 *           ╲    ╲    ╲    ╲    ╲    ╲    the slots: parallel diagonal roads
 *            ●━━━━┻━━━━┻━━━━┻━━━━┻━━━━●
 *            bottom lead (trailing turnouts)        ╲ out
 *
 * Each lead is just the run between the OUTER slots — it curves out of the running
 * line onto the LEADING slot and ends at the TRAILING slot, with no overshoot. The
 * yard has NO inherent direction: either lead can be the way in or out (the wider
 * layout + operator decide), exactly as the existing yard service treats its throats.
 * A train drives in on one lead, a turnout drops it into a slot to stable, and it
 * leaves by the other lead.
 *
 * Built on the Brio/IKEA 45°/200 mm grid, so it closes by construction and an
 * accidental same-layer overlap is a build-time error. Pure geometry/topology: no
 * DOM, no clock, no randomness.
 */
import type { Cursor, PieceNetworkBuilder, PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };

function side(n: number): PieceSpec[] {
  return Array.from({ length: n }, () => STRAIGHT);
}

export interface ParallelogramYardSegments {
  /** The diagonal slot segment ids (leading → trailing), where stock stables. */
  readonly slots: readonly string[];
  /** Top-lead turnout switch ids (one per slot): `thru` stays on the lead, `slot`
   *  drops into the slot. */
  readonly topSwitches: readonly string[];
  /** Bottom-lead turnout switch ids (one per slot). The yard is directionless: a
   *  train entering the BOTTOM lead diverts up a slot when its bottom switch is
   *  `slot`; a train coming down a slot from the top merges out when it is `slot`. */
  readonly bottomSwitches: readonly string[];
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
  /** Straights along each diagonal slot (its stabling length). */
  readonly slotStraights?: number;
  /** Straights of top-lead between adjacent slot turnouts (the slot stagger). */
  readonly leadStraights?: number;
}

/** A bottom-lead trailing turnout's outputs: its trunk cursor, its two converging
 *  legs (through + slot), and its switch. */
interface BottomMerge {
  readonly trunk: Cursor;
  readonly thruSeg: string;
  readonly branchSeg: string;
  readonly sw: string;
}

/** Lay a bottom-lead segment off `prev`'s trunk and converge `prev`'s two legs onto
 *  it (gated on `prev.sw`). When `target` is a cursor the segment is filler-sized to
 *  reach it (the next merge's through-entry); when null it's a single straight (the
 *  lead-out stub). Returns the segment's end cursor. */
function convergeBottomLead(
  b: PieceNetworkBuilder,
  id: string,
  prev: BottomMerge,
  target: Cursor | null,
  thruPos: string,
  slotPos: string,
): Cursor {
  let specs: PieceSpec[] = [STRAIGHT];
  if (target !== null) {
    const dist = Math.hypot(target.x - prev.trunk.x, target.y - prev.trunk.y);
    const full = Math.floor(dist / 200 + 1e-6);
    const filler = dist - full * 200;
    specs = side(full);
    if (filler > 0.5) specs.push({ type: 'straight', lengthMm: filler });
    if (specs.length === 0) specs = [STRAIGHT];
  }
  const end = b.run(id, prev.trunk, specs);
  b.link(prev.thruSeg, id, { switchId: prev.sw, position: thruPos });
  b.link(prev.branchSeg, id, { switchId: prev.sw, position: slotPos });
  return end;
}

/**
 * Add a parallelogram yard to `b` from `entry` (heading along `entry.dir` — the top
 * lead's direction). Lays the top-lead ladder of facing turnouts, the parallel
 * diagonal slots, and the bottom-lead chain of trailing turnouts that rejoins them.
 * Wires all internal links; the caller links its inbound run → `topLeadIn` and the
 * onward run ← `bottomLeadOutSeg`. Returns the segment/switch ids.
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

  const topLeadIn = `${p}-topin`;
  let topCursor = b.run(topLeadIn, entry, [STRAIGHT]);
  let prevTopSeg = topLeadIn;

  const slots: string[] = [];
  const topSwitches: string[] = [];
  const bottomSwitches: string[] = [];

  /* The bottom lead is chained left→right by short "lead" segments between consecutive
   *  trailing turnouts. BOTH a merge's legs (the through and the slot) converge to its
   *  trunk, so both link onto the next lead segment — GATED on the merge's bottom
   *  switch (`thru` = stay on the lead, `slot` = up the slot), which is what makes the
   *  yard work from either lead. The leading merge starts the lead (its through-entry
   *  is the dead west end); the final lead segment is the lead-out. */
  let prev: BottomMerge | null = null;
  let bottomLeadOutSeg = '';
  let bottomLeadOut: Cursor = entry;

  for (let i = 0; i < opts.slots; i++) {
    const sw = `${p}-sw${i}`;
    const topThru = `${p}-tt${i}`;
    const topBranch = `${p}-tb${i}`;
    /* Facing turnout on the top lead: through continues the lead, branch drops into
     *  the slot at 45°. */
    const { thruExit, branchExit } = b.junction(topThru, topBranch, topCursor, false);
    b.link(prevTopSeg, topThru, { switchId: sw, position: thruPos });
    b.link(prevTopSeg, topBranch, { switchId: sw, position: slotPos });

    /* The diagonal slot — a straight run at 45°, where stock stables. */
    const slot = `${p}-slot${i}`;
    const slotEnd = b.run(slot, branchExit, side(slotStraights));
    b.link(topBranch, slot);

    /* Trailing turnout converging the slot onto the bottom lead. */
    const botSw = `${p}-bsw${i}`;
    const botThru = `${p}-bt${i}`;
    const botBranch = `${p}-bb${i}`;
    const { trunkExit, thruEntry } = b.mergeJunction(botThru, botBranch, slotEnd, false);
    b.link(slot, botBranch);

    /* The previous merge's legs converge onto a lead segment that feeds this merge. */
    if (prev !== null) {
      const lead = `${p}-lead${i - 1}`;
      convergeBottomLead(b, lead, prev, thruEntry, thruPos, slotPos);
      b.link(lead, botThru);
    }
    prev = { trunk: trunkExit, thruSeg: botThru, branchSeg: botBranch, sw: botSw };

    slots.push(slot);
    topSwitches.push(sw);
    bottomSwitches.push(botSw);

    /* Advance the top lead to the next slot turnout (the slot stagger). */
    if (i < opts.slots - 1) {
      const gap = `${p}-tg${i}`;
      topCursor = b.run(gap, thruExit, side(leadStraights));
      b.link(topThru, gap);
      prevTopSeg = gap;
    } else {
      prevTopSeg = topThru;
      topCursor = thruExit;
    }
  }

  /* The lead-out: a final bottom-lead segment off the trailing merge's trunk that
   *  BOTH its legs converge onto — the caller links its onward run from here. */
  if (prev !== null) {
    const outId = `${p}-leadout`;
    bottomLeadOut = convergeBottomLead(b, outId, prev, null, thruPos, slotPos);
    bottomLeadOutSeg = outId;
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
