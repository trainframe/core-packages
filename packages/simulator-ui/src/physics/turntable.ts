/**
 * The turntable interior as a switched rail network (ADR-030, experimental/002).
 * To the physics it is ordinary track + a junction: a trunk lead runs onto a short
 * DECK segment, and the deck fans to one of several rim stubs. The live branch is
 * the deck angle the `TurntableActuator` has SEATED (it throws the switch only on
 * arrival), so a train is held at the approach until the bridge lines up — the
 * capacity-1 zone's clearance falls straight out of the unset switch.
 *
 * The headline behaviour is the TURN-AROUND. Crucially the DECK ITSELF IS A
 * ROTATING RAIL: its `at(d)` is computed live from the deck CENTRE plus the
 * actuator's current angle θ. A body parked at the deck centre therefore PIVOTS IN
 * PLACE as the deck swings — its rendered heading is the rail heading, which is θ,
 * so the loco physically turns end-for-end WITH the bridge (no sprite-flip, no
 * snap). After a half-turn the deck's far end points back WEST, so the loco drives
 * off heading the OTHER way, onto a westbound turn-around stub collinear with the
 * lead it arrived on — exactly what a real turntable does (reverse a loco on a
 * single lead). World mm. The single diverge node is the deck switch `Jt`.
 */
import type { RailPose } from '../track/pieces.js';
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import type { Rail } from './rail.js';
import { straightSeg } from './yard.js';

/** A rim stub: its switch POSITION, deck ANGLE (deg) when the bridge points at it,
 *  whether reaching it turns the loco around, and its world far endpoint. */
export interface TurntableStub {
  readonly position: string;
  readonly angleDeg: number;
  readonly flipsFacing: boolean;
  readonly endX: number;
  readonly endY: number;
}

/** A mutable angle source shared by the deck rail and the actuator. The actuator
 *  owns the rotation physics; each tick the scenario copies the actuator's current
 *  angle into here, so the rotating rail's geometry and the visual deck never
 *  diverge — both read this one number. */
export interface DeckAngleHolder {
  deg: number;
}

export interface TurntableLayout {
  readonly net: RailNetwork;
  /** Segment id → world endpoints (for rendering + the controller). The deck's
   *  entry is the static θ=0 geometry; its live geometry comes off `deckAngle`. */
  readonly geom: ReadonlyMap<string, { ax: number; ay: number; bx: number; by: number }>;
  readonly trunk: string;
  readonly deck: string;
  readonly deckCentre: { readonly x: number; readonly y: number };
  /** The deck pit radius (mm) — the rotating bridge spans its diameter. */
  readonly deckRadius: number;
  /** The drivable deck length (mm) — the body parks at `deckLength / 2` (centre). */
  readonly deckLength: number;
  readonly switchId: string;
  readonly stubs: readonly TurntableStub[];
  /** The shared live deck angle (deg). The scenario writes the actuator's angle
   *  here each tick; the deck rail and the rendered bridge both read it. */
  readonly deckAngle: DeckAngleHolder;
}

const SPINE_Y = 600;
const TRUNK_AX = 150;
const DECK_CENTRE_X = 700;
/** A chunky pit so the bridge + the loco riding it read clearly (the deck is the
 *  star of the scene; the radiating stubs are supporting cast). */
const DECK_RADIUS = 88;
/** How far each rim stub radiates out from the deck centre (mm) — kept short so
 *  the 8-spoke sunburst stays compact and the view frames the pit large. */
const STUB_LEN = 250;
/** The eight rim stubs of a full 8-way turntable, evenly spaced at 45° around the
 *  pit (angles measured from +x, y down). `stub-w` (180°) is collinear with the
 *  trunk lead — the TURN-AROUND exit, where a loco returns the way it came,
 *  reversed; `stub-e` (0°) is the straight-through; the rest are radiating stalls. */
const STUB_DIRS: ReadonlyArray<{ position: string; angleDeg: number }> = [
  { position: 'stub-e', angleDeg: 0 },
  { position: 'stub-se', angleDeg: 45 },
  { position: 'stub-s', angleDeg: 90 },
  { position: 'stub-sw', angleDeg: 135 },
  { position: 'stub-w', angleDeg: 180 },
  { position: 'stub-nw', angleDeg: 225 },
  { position: 'stub-n', angleDeg: 270 },
  { position: 'stub-ne', angleDeg: 315 },
];
const DECK_LENGTH = 2 * DECK_RADIUS;
/** West rim of the deck at θ=0 — where the trunk meets the bridge (the deck's
 *  start, d=0). */
const DECK_WEST_X = DECK_CENTRE_X - DECK_RADIUS;

/** Build the rotating deck as a custom `Rail`. It is a straight span of length
 *  `DECK_LENGTH` through the deck centre, but its orientation is the LIVE angle θ
 *  (read from `angle.deg` every call): a point `d` mm along it sits at distance
 *  `d − DECK_LENGTH/2` from the centre in direction θ, heading θ. So at d = centre
 *  the body stays on the centre and its heading IS θ — it pivots in place as the
 *  deck swings. Zero curvature/slope (a flat bridge); open at both ends (the loco
 *  drives on from the trunk and off onto a stub via the network, never buffers). */
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
    /* A straight (if swinging) span — no along-track curvature, so a body parked
     *  on it never derails however fast the deck rotates; the spin is the deck's,
     *  not the body's path. */
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

/**
 * Build the turntable: a trunk lead → rotating deck → eight rim stubs (a full
 * 8-way table). The headline service is the TURN-AROUND on `stub-w`: the deck
 * swings 180° from the boarding angle so the loco — carried round bodily on the
 * bridge — leaves FACING THE OTHER WAY, departing west along the stub collinear
 * with the lead it arrived on. The other seven are radiating exits the deck can
 * swing to (`stub-e` straight through, plus the diagonal/orthogonal stalls). The
 * deck switch `Jt` carries positions `trunk` + each stub.
 */
export function buildTurntableLayout(): TurntableLayout {
  const geom = new Map<string, { ax: number; ay: number; bx: number; by: number }>();
  const segments = new Map<string, Rail>();
  const links: NetLink[] = [];
  const deckCentre = { x: DECK_CENTRE_X, y: SPINE_Y };
  const deckAngle: DeckAngleHolder = { deg: 0 };

  const addStraight = (
    id: string,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    buffered = false,
  ) => {
    geom.set(id, { ax, ay, bx, by });
    segments.set(id, straightSeg(ax, ay, bx, by, { endBuffered: buffered }));
  };

  /* Trunk runs west→east into the deck's west rim. */
  addStraight('trunk', TRUNK_AX, SPINE_Y, DECK_WEST_X, SPINE_Y);
  /* The deck is the rotating bridge: its geometry is θ-driven, not a static line.
   *  We still record a θ=0 entry in `geom` (west→east through the centre) so the
   *  view has bounds; the LIVE pose comes off the rail. */
  geom.set('deck', {
    ax: DECK_WEST_X,
    ay: SPINE_Y,
    bx: DECK_CENTRE_X + DECK_RADIUS,
    by: SPINE_Y,
  });
  segments.set('deck', rotatingDeckRail(deckCentre, DECK_LENGTH, deckAngle));
  /* Board the deck whenever it is lined up with the trunk (θ=0). */
  links.push({ from: 'trunk', to: 'deck', when: { switchId: 'Jt', position: 'trunk' } });

  /* Eight rim stubs radiating at 45° around the pit. Each far end sits along its
   *  own angle so it reads as a clean spoke. NONE carry `flipsFacing`: any
   *  reversal is REAL — the rotating deck physically carries the loco round, so
   *  its heading (hence rendered rotation) already follows the bridge; a
   *  bookkeeping flip would double-reverse it. The loco always drives FORWARD off
   *  the deck's far end (whose +d direction is the stub's outward direction). */
  const stubs: TurntableStub[] = STUB_DIRS.map((dir) => {
    const rad = (dir.angleDeg * Math.PI) / 180;
    return {
      position: dir.position,
      angleDeg: dir.angleDeg,
      flipsFacing: false,
      endX: DECK_CENTRE_X + STUB_LEN * Math.cos(rad),
      endY: SPINE_Y + STUB_LEN * Math.sin(rad),
    };
  });
  for (const s of stubs) {
    const id = `seg-${s.position}`;
    /* The stub starts at the deck's far END as it sits at this stub's angle, so
     *  the loco's pose is continuous across the junction (the deck end heading at
     *  θ matches the stub's heading). */
    const rad = (s.angleDeg * Math.PI) / 180;
    const startX = DECK_CENTRE_X + DECK_RADIUS * Math.cos(rad);
    const startY = SPINE_Y + DECK_RADIUS * Math.sin(rad);
    addStraight(id, startX, startY, s.endX, s.endY, true);
    const link: NetLink = {
      from: 'deck',
      to: id,
      when: { switchId: 'Jt', position: s.position },
      ...(s.flipsFacing ? { flipsFacing: true } : {}),
    };
    links.push(link);
  }

  return {
    net: buildNetwork(segments, links),
    geom,
    trunk: 'trunk',
    deck: 'deck',
    deckCentre,
    deckRadius: DECK_RADIUS,
    deckLength: DECK_LENGTH,
    switchId: 'Jt',
    stubs,
    deckAngle,
  };
}

/** A world point part-way out along a stub's segment, clear of the deck — where a
 *  departed loco can be sensed once it has fully left the bridge. */
export function stubSensePoint(
  layout: TurntableLayout,
  position: string,
): { x: number; y: number } {
  const g = layout.geom.get(`seg-${position}`);
  if (g === undefined) throw new Error(`turntable: no stub ${position}`);
  /* Half-way along the stub: well clear of the deck, before the buffer. */
  return { x: (g.ax + g.bx) / 2, y: (g.ay + g.by) / 2 };
}
