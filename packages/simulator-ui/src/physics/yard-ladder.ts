/**
 * A railyard's TRACK, assembled from ordinary real pieces — no special `railyard`
 * piece. The running line passes straight through on the spine (in-line: a
 * non-visiting train never leaves it). A facing throat turnout taps off a diagonal
 * LEAD; a ladder of turnouts down that lead fans into parallel DEAD-END slots
 * (each a siding ending in a terminus buffer).
 *
 * Servicing is reverse-in (the classic "setting back"): a visiting train pulls
 * forward down the lead past a slot's turnout, then backs the rake in REAR-FIRST,
 * leaving the loco at the slot mouth so it can uncouple and pull forward out while
 * the gantry works the parked rake. That choreography is the yard DEVICE's job;
 * this module only lays the track and reports the segments/switches the device
 * declares ownership of (the markers "under the frame").
 *
 * Geometry: the throat diverts the lead to 45°; each ladder turnout is FLIPPED so
 * its branch levels back to horizontal (a slot) while its through continues the
 * 45° lead — so each successive slot sits lower and further along, fanned, never
 * crossing its neighbour. Pure geometry/topology: no DOM, no clock, no randomness.
 */
import type { Cursor, PieceNetworkBuilder, PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const TERMINUS: PieceSpec = { type: 'terminus' };

/** The segments + switches a yard ladder contributes. The yard device declares
 *  ownership of `throatSwitch` + `ladderSwitches` (and the markers on the slots /
 *  lead) — these are the interior "under the frame". */
export interface YardLadderSegments {
  /** Running line continuing past the throat (throat set to `thru`). */
  readonly spineThrough: string;
  /** The diagonal lead into the yard (throat set to `enter`). */
  readonly lead: string;
  /** Dead-end slot segment ids, fanned in placement order. */
  readonly slots: readonly string[];
  /** Switch that admits a train into the yard vs keeps it on the running line. */
  readonly throatSwitch: string;
  /** One switch per ladder turnout: `thru` continues the lead, `slot` peels off. */
  readonly ladderSwitches: readonly string[];
  /** Throat position that keeps a train on the running line. */
  readonly thruPos: string;
  /** Throat position that admits a train into the yard. */
  readonly enterPos: string;
  /** Ladder position that continues down the lead. */
  readonly ladderThruPos: string;
  /** Ladder position that peels off into this turnout's slot. */
  readonly ladderSlotPos: string;
}

export interface YardLadderOptions {
  /** Unique prefix for this yard's segment + switch ids. */
  readonly prefix: string;
  /** Number of dead-end slots. */
  readonly slots: number;
  /** Straights per slot before the terminus buffer (slot length). */
  readonly slotStraights?: number;
}

/**
 * Add a yard ladder to `b` starting at `entry` (the running line, heading
 * `entry.dir`). Wires all internal links; the caller links its inbound run to the
 * returned `inbound` segment and the onward running line ← `spineThrough`. Returns
 * the spine exit cursor (running line continues), the segment/switch ids, and the
 * `inbound` segment id.
 */
export function addYardLadder(
  b: PieceNetworkBuilder,
  entry: Cursor,
  opts: YardLadderOptions,
): { spineExit: Cursor; segments: YardLadderSegments; inbound: string } {
  const p = opts.prefix;
  const slotStraights = opts.slotStraights ?? 2;
  const throatSwitch = `${p}-throat`;
  const thruPos = 'thru';
  const enterPos = 'enter';
  const ladderThruPos = 'thru';
  const ladderSlotPos = 'slot';

  /* Inbound stub so the throat's two paths have one segment to gate from. */
  const inbound = `${p}-in`;
  const afterIn = b.run(inbound, entry, [STRAIGHT]);

  /* Throat: stay on the running line (spine) or divert onto the 45° lead. */
  const spineThrough = `${p}-spine`;
  const lead = `${p}-lead`;
  const { thruExit: spineExit, branchExit: leadStart } = b.junction(spineThrough, lead, afterIn);
  b.link(inbound, spineThrough, { switchId: throatSwitch, position: thruPos });
  b.link(inbound, lead, { switchId: throatSwitch, position: enterPos });

  /* Ladder down the lead: each FLIPPED turnout levels a slot off horizontally. */
  const slots: string[] = [];
  const ladderSwitches: string[] = [];
  let prevLead = lead;
  let leadCursor = leadStart;
  for (let i = 0; i < opts.slots; i++) {
    const ladderSwitch = `${p}-lad${i}`;
    const leadThru = `${p}-lthru${i}`;
    const slotBranch = `${p}-slotb${i}`;
    const slot = `${p}-slot${i}`;
    const { thruExit, branchExit } = b.junction(leadThru, slotBranch, leadCursor, true);
    b.run(slot, branchExit, [...Array.from({ length: slotStraights }, () => STRAIGHT), TERMINUS]);
    b.link(prevLead, leadThru, { switchId: ladderSwitch, position: ladderThruPos });
    b.link(prevLead, slotBranch, { switchId: ladderSwitch, position: ladderSlotPos });
    b.link(slotBranch, slot);
    slots.push(slot);
    ladderSwitches.push(ladderSwitch);
    prevLead = leadThru;
    leadCursor = thruExit;
  }

  /* Cap the lead with a buffer so it is a closed dead-end, not an open run-off. */
  const leadEnd = `${p}-leadend`;
  b.run(leadEnd, leadCursor, [TERMINUS]);
  b.link(prevLead, leadEnd);

  return {
    spineExit,
    inbound,
    segments: {
      spineThrough,
      lead,
      slots,
      throatSwitch,
      ladderSwitches,
      thruPos,
      enterPos,
      ladderThruPos,
      ladderSlotPos,
    },
  };
}
