/**
 * The turntable interior as a switched rail network (ADR-030, experimental/002).
 * To the physics it is ordinary track + a junction: a trunk lead runs onto a short
 * DECK segment, and the deck fans to one of several rim stubs. The live branch is
 * the deck angle the `TurntableActuator` has SEATED (it throws the switch only on
 * arrival), so a train is held at the approach until the bridge lines up — the
 * capacity-1 zone's clearance falls straight out of the unset switch.
 *
 * The headline stub is the TURN-AROUND (`flipsFacing`): a loco that boarded heading
 * one way leaves it the OTHER way (the deck swung 180°). World mm. The single
 * diverge node is the deck switch `Jt`.
 */
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

export interface TurntableLayout {
  readonly net: RailNetwork;
  /** Segment id → world endpoints (for rendering + the controller). */
  readonly geom: ReadonlyMap<string, { ax: number; ay: number; bx: number; by: number }>;
  readonly trunk: string;
  readonly deck: string;
  readonly deckCentre: { readonly x: number; readonly y: number };
  /** The deck pit radius (mm) — the rotating bridge spans its diameter. */
  readonly deckRadius: number;
  readonly switchId: string;
  readonly stubs: readonly TurntableStub[];
}

const SPINE_Y = 600;
const TRUNK_AX = 150;
const DECK_WEST_X = 640;
const DECK_EAST_X = 760;
const DECK_CENTRE_X = (DECK_WEST_X + DECK_EAST_X) / 2;
const DECK_RADIUS = (DECK_EAST_X - DECK_WEST_X) / 2;

/**
 * Build the turntable: a trunk lead → deck → three rim stubs. The east stub is the
 * TURN-AROUND (the deck swings 180° from the boarding angle and the loco leaves
 * reversed); the other two are ordinary radiating exits, present so the deck has
 * real choices to swing between. The deck switch `Jt` carries positions
 * `trunk` + each stub.
 */
export function buildTurntableLayout(): TurntableLayout {
  const geom = new Map<string, { ax: number; ay: number; bx: number; by: number }>();
  const segments = new Map<string, Rail>();
  const links: NetLink[] = [];

  const add = (id: string, ax: number, ay: number, bx: number, by: number, buffered = false) => {
    geom.set(id, { ax, ay, bx, by });
    segments.set(id, straightSeg(ax, ay, bx, by, { endBuffered: buffered }));
  };

  /* Trunk runs west→east into the deck's west end; the deck is the short bridge. */
  add('trunk', TRUNK_AX, SPINE_Y, DECK_WEST_X, SPINE_Y);
  add('deck', DECK_WEST_X, SPINE_Y, DECK_EAST_X, SPINE_Y);
  /* Board the deck whenever it is lined up with the trunk. */
  links.push({ from: 'trunk', to: 'deck', when: { switchId: 'Jt', position: 'trunk' } });

  const stubs: TurntableStub[] = [
    /* The turn-around: collinear east, deck swung a half-turn from the trunk.
     * A loco driving forward off the deck crosses this flipping link and departs
     * facing the OTHER way (still rolling east, but now pointing west). */
    { position: 'stub-e', angleDeg: 180, flipsFacing: true, endX: 1160, endY: SPINE_Y },
    /* Two ordinary radiating exits the deck can also swing to (no turn). */
    { position: 'stub-n', angleDeg: 135, flipsFacing: false, endX: 1040, endY: SPINE_Y - 300 },
    { position: 'stub-s', angleDeg: 225, flipsFacing: false, endX: 1040, endY: SPINE_Y + 300 },
  ];
  for (const s of stubs) {
    const id = `seg-${s.position}`;
    add(id, DECK_EAST_X, SPINE_Y, s.endX, s.endY, true);
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
    deckCentre: { x: DECK_CENTRE_X, y: SPINE_Y },
    deckRadius: DECK_RADIUS,
    switchId: 'Jt',
    stubs,
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
  /* Half-way along the stub: well east of the deck, before the buffer. */
  return { x: (g.ax + g.bx) / 2, y: (g.ay + g.by) / 2 };
}
