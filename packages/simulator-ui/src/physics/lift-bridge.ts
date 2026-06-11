/**
 * The lift-bridge interior as a switched/linked rail network (ADR-030,
 * experimental/005). To the physics it is the simplest possible thing: two fixed
 * straight approach rails (`near`, `far`) joined by a short SPAN segment in the
 * middle. The two joints that attach the span to the approaches are LINKS carrying
 * an id, so the world can DISCONNECT them at runtime — that is the whole trick. A
 * raised span means those links are absent: a body driving off the near approach's
 * end finds nothing connected and meets the rail end (open → it would run off the
 * gap; we make the near approach's far end OPEN so a held train that crept on would
 * fall into the gap, proving the hold is real, not buffered luck).
 *
 * When the span is down (links connected) the three segments form one continuous
 * line near → span → far and a train rolls straight across.
 *
 * World mm. The bridge link id is `BRIDGE` (both joints share it — raising the
 * span breaks both ends at once). Pure geometry/topology, DOM-free.
 */
import { type NetLink, type RailNetwork, buildNetwork } from './network.js';
import type { Rail } from './rail.js';
import { straightSeg } from './yard.js';

export interface LiftBridgeLayout {
  readonly net: RailNetwork;
  /** Segment id → world endpoints (for rendering + bounds). */
  readonly geom: ReadonlyMap<string, { ax: number; ay: number; bx: number; by: number }>;
  readonly near: string;
  readonly span: string;
  readonly far: string;
  /** The shared link id the lift-bridge actuator connects/disconnects. */
  readonly linkId: string;
  /** Where the near approach ends / the span begins (the near gap edge). */
  readonly spanStart: { readonly x: number; readonly y: number };
  /** Where the span ends / the far approach begins (the far gap edge). */
  readonly spanEnd: { readonly x: number; readonly y: number };
  /** A world point out on the far approach, past the span — where a crossed train
   *  is sensed. */
  readonly farSensePoint: { readonly x: number; readonly y: number };
}

const RAIL_Y = 600;
const NEAR_AX = 150;
const SPAN_START_X = 620;
const SPAN_END_X = 820;
const FAR_BX = 1290;

/** Build the lift bridge: a near approach → liftable span → far approach, the two
 *  span joints carried on one disconnectable link (`BRIDGE`). The near approach's
 *  far end is OPEN (not buffered), so if the span is up and a train were wrongly
 *  released it would run off into the gap — which is exactly what the controller
 *  must prevent by withholding. The far approach buffers at its far end so a
 *  crossed train comes cleanly to rest. */
export function buildLiftBridgeLayout(): LiftBridgeLayout {
  const geom = new Map<string, { ax: number; ay: number; bx: number; by: number }>();
  const segments = new Map<string, Rail>();
  const linkId = 'BRIDGE';

  const addStraight = (
    id: string,
    ax: number,
    bx: number,
    ends: { startBuffered?: boolean; endBuffered?: boolean } = {},
  ): void => {
    geom.set(id, { ax, ay: RAIL_Y, bx, by: RAIL_Y });
    segments.set(id, straightSeg(ax, RAIL_Y, bx, RAIL_Y, ends));
  };

  /* near: buffered at its START (its own approach terminus) but OPEN at the gap
   *  end, so a wrongly-released train runs off into the raised gap. */
  addStraight('near', NEAR_AX, SPAN_START_X, { startBuffered: true });
  /* span: the liftable deck — open both ends, reached only via the links. */
  addStraight('span', SPAN_START_X, SPAN_END_X);
  /* far: open at the gap end, buffered at the far terminus. */
  addStraight('far', SPAN_END_X, FAR_BX, { endBuffered: true });

  const links: NetLink[] = [
    { from: 'near', to: 'span', id: linkId },
    { from: 'span', to: 'far', id: linkId },
  ];

  return {
    net: buildNetwork(segments, links),
    geom,
    near: 'near',
    span: 'span',
    far: 'far',
    linkId,
    spanStart: { x: SPAN_START_X, y: RAIL_Y },
    spanEnd: { x: SPAN_END_X, y: RAIL_Y },
    farSensePoint: { x: (SPAN_END_X + FAR_BX) / 2, y: RAIL_Y },
  };
}
