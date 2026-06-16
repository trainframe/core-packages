/**
 * The DEPOT / roundhouse interior as a switched rail network (ADR-032 — the first
 * concrete two-level nested opaque zone). To core the depot is ONE opaque zone of
 * capacity N (ADR-026); its INTERIOR is organised around a central TURNTABLE (a
 * capacity-1 zone), and a fan of STALL tracks radiates off the turntable's rim.
 *
 * To the physics it is ordinary track + a single junction, exactly like the
 * standalone turntable (`physics/turntable.ts`, which this COMPOSES rather than
 * edits): an entry lead runs onto a rotating DECK, and the deck fans to one of
 * several rim stubs — but here each stub leads on into a STALL track (the
 * roundhouse bay where a loco parks). The live branch is whichever deck angle the
 * `TurntableActuator` has SEATED, so a train is held at the approach until the
 * bridge lines up — the inner capacity-1 zone's clearance falls straight out of
 * the unset switch, and the depot orchestrates it (ADR-032 §1: report upward).
 *
 * The DECK ITSELF IS A ROTATING RAIL: its `at(d)` is computed live from the deck
 * centre plus the actuator's current angle θ (the shared `DeckAngleHolder`), so a
 * loco parked at the deck centre PIVOTS IN PLACE as the deck swings — the honest
 * turn, no sprite-flip (ADR-030). World mm. The single diverge node is the deck
 * switch `Jd`.
 */
import type { RailPose } from '../track/pieces.js';
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import type { Rail } from './rail.js';
import { straightSeg } from './yard.js';

/** A mutable angle source shared by the deck rail and the actuator. The actuator
 *  owns the rotation physics; each tick the scenario copies the actuator's current
 *  angle into here, so the rotating rail's geometry and the visual deck never
 *  diverge — both read this one number. (Same contract as the turntable's.) */
export interface DeckAngleHolder {
  deg: number;
}

/** One roundhouse stall: the switch POSITION that lines the deck up with it, the
 *  deck ANGLE (deg) at that position, and the world geometry of its rim stub +
 *  parking track (for rendering and for the controller's sense points). */
export interface DepotStall {
  /** Stall id, also the deck switch position that selects it (e.g. `stall-0`). */
  readonly id: string;
  /** Deck angle (deg from +x, y down) at which the bridge points at this stall. */
  readonly angleDeg: number;
  /** The short rim stub from the deck rim out to the stall mouth. */
  readonly stubSeg: string;
  /** The stall parking track the loco comes to rest on. */
  readonly stallSeg: string;
}

export interface DepotLayout {
  readonly net: RailNetwork;
  /** Segment id → world endpoints (for rendering + the controller). */
  readonly geom: ReadonlyMap<string, { ax: number; ay: number; bx: number; by: number }>;
  /** The entry lead the visiting loco arrives on. */
  readonly entry: string;
  /** The rotating deck segment id. */
  readonly deck: string;
  readonly deckCentre: { readonly x: number; readonly y: number };
  /** The deck pit radius (mm) — the rotating bridge spans its diameter. */
  readonly deckRadius: number;
  /** The drivable deck length (mm); a body parks at `deckLength / 2` (centre). */
  readonly deckLength: number;
  /** The deck switch id (positions: `entry` + each stall id). */
  readonly switchId: string;
  /** The switch position that lines the deck up with the entry lead. */
  readonly entryPosition: string;
  readonly stalls: readonly DepotStall[];
  /** Shared live deck angle (deg). The scenario writes the actuator's angle here
   *  each tick; the deck rail and the rendered bridge both read it. */
  readonly deckAngle: DeckAngleHolder;
}

const SPINE_Y = 600;
const ENTRY_AX = 120;
const DECK_CENTRE_X = 760;
/** A chunky pit so the bridge + the loco riding it read clearly. */
const DECK_RADIUS = 86;
const DECK_LENGTH = 2 * DECK_RADIUS;
/** West rim of the deck at θ=0 — where the entry lead meets the bridge (d=0). */
const DECK_WEST_X = DECK_CENTRE_X - DECK_RADIUS;
/** Length of each rim stub (deck rim → stall mouth) and the stall track itself. */
const STUB_LEN = 70;
const STALL_LEN = 230;

/**
 * The roundhouse fan: stalls radiate from the deck around the pit. The entry
 * comes in from the WEST and boards the deck at θ=0 (the deck's d=0 west rim meets
 * the entry's east end, pose-continuous — exactly the standalone turntable's
 * boarding geometry). The stalls fan over the SOUTH/EAST/NORTH arc, each well
 * clear of the entry lead (which sits at 180°); the deck swings from 0° to the
 * chosen stall's angle to route a loco onto it. Angles are the DECK angle
 * (deg, +x / y-down) at which the bridge far end points at each stall.
 */
const ENTRY_ANGLE_DEG = 0;
const STALL_ANGLES_DEG: readonly number[] = [60, 100, 260, 300];

/** Build the rotating deck as a custom `Rail`: a straight span of length
 *  `DECK_LENGTH` through the deck centre whose orientation is the LIVE angle θ
 *  (read from `angle.deg` every call). A point `d` along it sits at distance
 *  `d − DECK_LENGTH/2` from the centre in direction θ, heading θ — so at the
 *  centre the body stays put and its heading IS θ (it pivots in place as the deck
 *  swings). Zero curvature/slope; open at both ends (the loco drives on from the
 *  entry and off onto a stub via the network, never buffers). Mirrors the
 *  standalone turntable's deck rail — composed here, not edited there. */
function rotatingDeckRail(
  centre: { readonly x: number; readonly y: number },
  length: number,
  angle: DeckAngleHolder,
): Rail {
  const at = (d: number): RailPose => {
    const offset = Math.max(0, Math.min(length, d)) - length / 2;
    const rad = (angle.deg * Math.PI) / 180;
    return {
      x: centre.x + offset * Math.cos(rad),
      y: centre.y + offset * Math.sin(rad),
      headingDeg: ((angle.deg % 360) + 360) % 360,
    };
  };
  return {
    length,
    at,
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

/**
 * Build the depot: an entry lead → rotating deck → a fan of stall tracks off the
 * deck's rim. The deck switch `Jd` carries positions `entry` + each stall id; the
 * deck seats a position only on mechanical arrival (the `TurntableActuator`), so a
 * train is never routed onto a moving or mis-aligned bridge. Each stall is a rim
 * stub (deck rim → mouth) + a parking track (BUFFERED at its far end, so a loco
 * driving in comes to a dead stop in the bay).
 */
export function buildDepotLayout(): DepotLayout {
  const geom = new Map<string, { ax: number; ay: number; bx: number; by: number }>();
  const segments = new Map<string, Rail>();
  const links: NetLink[] = [];
  const deckCentre = { x: DECK_CENTRE_X, y: SPINE_Y };
  const deckAngle: DeckAngleHolder = { deg: ENTRY_ANGLE_DEG };

  const addStraight = (
    id: string,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    buffered = false,
  ): void => {
    geom.set(id, { ax, ay, bx, by });
    segments.set(id, straightSeg(ax, ay, bx, by, { endBuffered: buffered }));
  };

  /* The entry lead runs west→east into the deck's west rim. */
  addStraight('entry', ENTRY_AX, SPINE_Y, DECK_WEST_X, SPINE_Y);

  /* The deck is the rotating bridge: its geometry is θ-driven, not a static line.
   *  We record a θ=0 (east-pointing) entry in `geom` so the view has bounds; the
   *  LIVE pose comes off the rail. */
  geom.set('deck', {
    ax: DECK_WEST_X,
    ay: SPINE_Y,
    bx: DECK_CENTRE_X + DECK_RADIUS,
    by: SPINE_Y,
  });
  segments.set('deck', rotatingDeckRail(deckCentre, DECK_LENGTH, deckAngle));

  /* Board the deck off the entry lead when the bridge is lined up with the entry
   *  (θ = 180°). The deck's d=0 end is its WEST rim; at θ=180 that end faces east
   *  (toward the centre) while its FAR end (d=L) faces west — collinear with the
   *  entry. A body driving forward off the entry's east end transitions onto the
   *  deck START; a body driving forward off the deck FAR end transitions to a
   *  stall. So the entry links to the deck (entry→deck), the stalls hang off the
   *  deck's far end (deck→stub). */
  links.push({ from: 'entry', to: 'deck', when: { switchId: 'Jd', position: 'entry' } });

  const stalls: DepotStall[] = STALL_ANGLES_DEG.map((angleDeg, i) => {
    const id = `stall-${i}`;
    const stubSeg = `stub-${i}`;
    const stallSeg = `track-${i}`;
    const rad = (angleDeg * Math.PI) / 180;
    /* The stub starts at the deck's FAR end as it sits at this stall's angle, so
     *  the loco's pose is continuous across the junction. */
    const stubStartX = DECK_CENTRE_X + DECK_RADIUS * Math.cos(rad);
    const stubStartY = SPINE_Y + DECK_RADIUS * Math.sin(rad);
    const stubEndX = DECK_CENTRE_X + (DECK_RADIUS + STUB_LEN) * Math.cos(rad);
    const stubEndY = SPINE_Y + (DECK_RADIUS + STUB_LEN) * Math.sin(rad);
    const stallEndX = DECK_CENTRE_X + (DECK_RADIUS + STUB_LEN + STALL_LEN) * Math.cos(rad);
    const stallEndY = SPINE_Y + (DECK_RADIUS + STUB_LEN + STALL_LEN) * Math.sin(rad);
    addStraight(stubSeg, stubStartX, stubStartY, stubEndX, stubEndY);
    /* The stall track is BUFFERED at its far end: a loco driving in stops dead in
     *  the bay (a roundhouse stall is a dead end). */
    addStraight(stallSeg, stubEndX, stubEndY, stallEndX, stallEndY, true);
    return { id, angleDeg, stubSeg, stallSeg };
  });
  for (const s of stalls) {
    /* The deck's FAR end (d=L) feeds the stub when the bridge is seated on this
     *  stall's angle; the stub then runs straight on into the parking track. */
    links.push({ from: 'deck', to: s.stubSeg, when: { switchId: 'Jd', position: s.id } });
    links.push({ from: s.stubSeg, to: s.stallSeg });
  }

  return {
    net: buildNetwork(segments, links),
    geom,
    entry: 'entry',
    deck: 'deck',
    deckCentre,
    deckRadius: DECK_RADIUS,
    deckLength: DECK_LENGTH,
    switchId: 'Jd',
    entryPosition: 'entry',
    stalls,
    deckAngle,
  };
}

/** A world point part-way along a stall track, well inside the bay — where a
 *  parked loco can be sensed once it has fully driven in off the deck. */
export function stallSensePoint(layout: DepotLayout, stallSeg: string): { x: number; y: number } {
  const g = layout.geom.get(stallSeg);
  if (g === undefined) throw new Error(`depot: no stall track ${stallSeg}`);
  /* Two-thirds of the way in: clear of the mouth, short of the buffer. */
  return { x: g.ax + (g.bx - g.ax) * 0.66, y: g.ay + (g.by - g.ay) * 0.66 };
}
