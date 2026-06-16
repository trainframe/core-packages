/**
 * A railyard's TRACK, assembled from ordinary real pieces — no special `railyard`
 * piece. The running line passes straight through on the spine (in-line: a
 * non-visiting train never leaves it). A facing throat turnout taps off a diagonal
 * LEAD; a ladder of TRAILING turnouts down that lead peels off parallel DEAD-END
 * slots (each a siding ending in a terminus buffer), and the lead finishes in a
 * HEADSHUNT (a spur long enough to hold a whole train).
 *
 * Servicing is REVERSE-IN (the classic "setting back"): a visiting train pulls
 * forward down the lead, past its target slot's turnout, right onto the headshunt;
 * then it BACKS the rake in rear-first, the trailing turnout diverting it into the
 * slot, so the loco ends at the slot MOUTH — free to uncouple and pull out forward
 * while the gantry works the parked rake. That choreography is the yard DEVICE's
 * job; this module only lays the track and reports the segments/switches the device
 * declares ownership of (the markers "under the frame").
 *
 * Why trailing turnouts: a dead-end slot can only be BACKED into. A facing turnout
 * (trunk toward the throat) funnels a reversing train back to the trunk — it can
 * never cross into the slot. A trailing turnout (trunk down-lead, toward the
 * headshunt) passes a forward train straight by, then — approached from the trunk
 * side on the reverse — diverts it into the slot. See `trailingJunction`.
 *
 * Geometry: the throat diverts the lead to 45°; each ladder turnout's branch levels
 * back to horizontal (a slot) while its trunk continues the 45° lead — so each
 * successive slot sits lower and further along, fanned, never crossing its
 * neighbour. Pure geometry/topology: no DOM, no clock, no randomness.
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
  /** Dead-end slot segment ids, fanned in placement order. A train BACKS into one. */
  readonly slots: readonly string[];
  /** The headshunt at the foot of the lead — the spur a train pulls onto before
   *  setting back into a slot. Holds a whole train clear of every slot turnout. */
  readonly headshunt: string;
  /** Switch that admits a train into the yard vs keeps it on the running line. */
  readonly throatSwitch: string;
  /** One switch per ladder turnout: `thru` passes down the lead, `slot` (on the
   *  REVERSE move) diverts into this turnout's slot. */
  readonly ladderSwitches: readonly string[];
  /** Throat position that keeps a train on the running line. */
  readonly thruPos: string;
  /** Throat position that admits a train into the yard. */
  readonly enterPos: string;
  /** Ladder position that continues down the lead (a forward pass / reverse run-up). */
  readonly ladderThruPos: string;
  /** Ladder position that diverts a reversing train into this turnout's slot. */
  readonly ladderSlotPos: string;
}

export interface YardLadderOptions {
  /** Unique prefix for this yard's segment + switch ids. */
  readonly prefix: string;
  /** Number of dead-end slots. */
  readonly slots: number;
  /** Straights per slot before the terminus buffer (slot length). */
  readonly slotStraights?: number;
  /** Straights of lead between consecutive slot turnouts (turnout spacing). */
  readonly rungStraights?: number;
  /** Straights of headshunt past the last slot turnout (must hold a whole train). */
  readonly headshuntStraights?: number;
}

/** Lay a dead-end siding BUFFER-FIRST so the rail's END lands on `mouth` (the
 *  turnout's branch endpoint). The siding extends from the buffer back toward the
 *  mouth, so its forward direction is buffer→mouth — the loco's pull-OUT — and a
 *  reversing train backs in toward the buffer. `straights` 200 mm cars long. */
function layBufferFirstSiding(
  b: PieceNetworkBuilder,
  id: string,
  mouth: Cursor,
  straights: number,
): void {
  const rad = (mouth.dir * Math.PI) / 180;
  const length = straights * 200;
  const buffer: Cursor = {
    x: mouth.x + length * Math.cos(rad),
    y: mouth.y + length * Math.sin(rad),
    dir: (mouth.dir + 180) % 360,
    layer: mouth.layer,
  };
  b.run(id, buffer, [TERMINUS, ...Array.from({ length: straights }, () => STRAIGHT)]);
}

/**
 * Add a reverse-in yard ladder to `b` starting at `entry` (the running line,
 * heading `entry.dir`). Wires all internal links; the caller links its inbound run
 * to the returned `inbound` segment and the onward running line ← `spineThrough`.
 * Returns the spine exit cursor (running line continues), the segment/switch ids,
 * and the `inbound` segment id.
 */
export function addYardLadder(
  b: PieceNetworkBuilder,
  entry: Cursor,
  opts: YardLadderOptions,
): { spineExit: Cursor; segments: YardLadderSegments; inbound: string } {
  const p = opts.prefix;
  const slotStraights = opts.slotStraights ?? 2;
  const rungStraights = opts.rungStraights ?? 1;
  const headshuntStraights = opts.headshuntStraights ?? 3;
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

  /* Ladder down the lead: each TRAILING turnout passes a forward train down the
   * lead and backs a reversing train into a slot. The onward lead segment after
   * turnout i is fed by the pass (thru) and by slot i's rail (slot) — so a reverse
   * off that segment diverts into slot i exactly when its switch says so. */
  const slots: string[] = [];
  const ladderSwitches: string[] = [];
  /* Per-turnout feeders, wired to their onward segment once it exists. */
  const onwardFeeders: { pass: string; slotRail: string; ladderSwitch: string }[] = [];
  let leadCursor = leadStart;
  for (let i = 0; i < opts.slots; i++) {
    const ladderSwitch = `${p}-lad${i}`;
    const pass = `${p}-pass${i}`;
    const slotRail = `${p}-slotr${i}`;
    const slot = `${p}-slot${i}`;
    /* A short lead approach so consecutive turnouts don't overlap; the throat's
     * lead branch feeds the first one, each onward feed feeds the rest. */
    const app = `${p}-app${i}`;
    const appExit = b.run(
      app,
      leadCursor,
      Array.from({ length: rungStraights }, () => STRAIGHT),
    );
    if (i === 0) b.link(lead, app);
    const { trunkExit, branchExit } = b.trailingJunction(pass, slotRail, appExit, true);
    layBufferFirstSiding(b, slot, branchExit, slotStraights);
    /* Forward pass INTO this turnout's through; the slot rail joins its mouth. */
    b.link(app, pass, { switchId: ladderSwitch, position: ladderThruPos });
    b.link(slot, slotRail);
    slots.push(slot);
    ladderSwitches.push(ladderSwitch);
    leadCursor = trunkExit;
    onwardFeeders.push({ pass, slotRail, ladderSwitch });
  }

  /* Headshunt: the spur a train pulls fully onto before setting back. */
  const headshunt = `${p}-headshunt`;
  b.run(headshunt, leadCursor, [
    ...Array.from({ length: headshuntStraights }, () => STRAIGHT),
    TERMINUS,
  ]);

  /* Wire each turnout's onward feed: the segment AFTER turnout i is rung i+1's
   * approach, or the headshunt for the last rung. */
  for (let i = 0; i < onwardFeeders.length; i++) {
    const f = onwardFeeders[i];
    if (f === undefined) continue;
    const onward = i + 1 < onwardFeeders.length ? `${p}-app${i + 1}` : headshunt;
    b.link(f.pass, onward, { switchId: f.ladderSwitch, position: ladderThruPos });
    b.link(f.slotRail, onward, { switchId: f.ladderSwitch, position: ladderSlotPos });
  }

  return {
    spineExit,
    inbound,
    segments: {
      spineThrough,
      lead,
      slots,
      headshunt,
      throatSwitch,
      ladderSwitches,
      thruPos,
      enterPos,
      ladderThruPos,
      ladderSlotPos,
    },
  };
}
