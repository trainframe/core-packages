/**
 * A compact TRAPEZOID goods yard from real pieces — a drive-in stabling fan. From an
 * entry off the running line it levels to a horizontal lead, then a ladder of facing
 * turnouts peels off parallel DEAD-END sidings (each a few straights to a terminus
 * buffer). A train drives in loco-first to stable; the staggered turnouts give the
 * classic trapezoid throat. Not reverse-in (that was rejected) — straightforward
 * drive-in.
 *
 * Pure geometry/topology: no DOM, no clock, no randomness.
 */
import type { Cursor, PieceNetworkBuilder, PieceSpec } from './piece-network.js';

const STRAIGHT: PieceSpec = { type: 'straight' };
const TERMINUS: PieceSpec = { type: 'terminus' };
const LEVEL: PieceSpec = { type: 'curve', flipped: true };

export interface TrapezoidYardSegments {
  /** The lead a train enters on (throat). */
  readonly lead: string;
  /** Dead-end siding segment ids, fanned. */
  readonly sidings: readonly string[];
  /** One switch per ladder turnout: `thru` continues the lead, `slot` peels into the siding. */
  readonly ladderSwitches: readonly string[];
  readonly thruPos: string;
  readonly slotPos: string;
}

export interface TrapezoidYardOptions {
  readonly prefix: string;
  /** Number of dead-end sidings. */
  readonly sidings: number;
  /** Straights per siding before the buffer. */
  readonly sidingStraights?: number;
}

/**
 * Add a trapezoid yard to `b` from `entry` (the diverted branch off the running line,
 * heading `entry.dir`). Levels the divert to horizontal, then ladders out the sidings.
 * Wires all internal links; the caller links its inbound run → the returned `inbound`.
 * Returns the segment/switch ids and the `inbound` segment id.
 */
export function addTrapezoidYard(
  b: PieceNetworkBuilder,
  entry: Cursor,
  opts: TrapezoidYardOptions,
): { segments: TrapezoidYardSegments; inbound: string } {
  const p = opts.prefix;
  const sidingStraights = opts.sidingStraights ?? 2;
  const thruPos = 'thru';
  const slotPos = 'slot';

  /* Inbound stub + level the 45° divert to a horizontal lead. */
  const inbound = `${p}-in`;
  const afterIn = b.run(inbound, entry, [STRAIGHT, LEVEL]);

  const sidings: string[] = [];
  const ladderSwitches: string[] = [];
  let prevLead = inbound;
  let leadCursor = afterIn;
  for (let i = 0; i < opts.sidings; i++) {
    const ladderSwitch = `${p}-lad${i}`;
    const leadThru = `${p}-lead${i}`;
    const sidingBranch = `${p}-sb${i}`;
    const siding = `${p}-siding${i}`;
    /* Facing turnout: through continues the lead, branch peels off (flipped so the
     *  siding levels back to horizontal, parallel to the others — the fan). */
    const { thruExit, branchExit } = b.junction(leadThru, sidingBranch, leadCursor, true);
    b.run(siding, branchExit, [
      LEVEL,
      ...Array.from({ length: sidingStraights }, () => STRAIGHT),
      TERMINUS,
    ]);
    b.link(prevLead, leadThru, { switchId: ladderSwitch, position: thruPos });
    b.link(prevLead, sidingBranch, { switchId: ladderSwitch, position: slotPos });
    b.link(sidingBranch, siding);
    sidings.push(siding);
    ladderSwitches.push(ladderSwitch);
    prevLead = leadThru;
    leadCursor = thruExit;
  }
  /* Cap the lead with a buffer so the last road is a dead-end too. */
  const leadEnd = `${p}-leadend`;
  b.run(leadEnd, leadCursor, [TERMINUS]);
  b.link(prevLead, leadEnd);

  return {
    inbound,
    segments: {
      lead: `${p}-lead0`,
      sidings,
      ladderSwitches,
      thruPos,
      slotPos,
    },
  };
}
