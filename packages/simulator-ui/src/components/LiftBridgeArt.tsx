/**
 * Shared lift-bridge art (ADR-024 wood/workshop aesthetic), drawn purely from the
 * geometry + the actuator's REAL raise fraction — never animated, never reading
 * ground truth. Both the controlled `LiftBridgeScenarioView` and the contrasting
 * `BridgeRunoffScenarioView` render this SAME component so the two demos are
 * visually identical; only the behaviour (a train held vs. a train running off)
 * differs.
 *
 * Drawn entirely in PLAN VIEW to match the rest of the toy table — it is a
 * bascule that seesaws about a transverse hinge across the track:
 *   - the DECK LEAF (one arm of the seesaw) foreshortens toward the hinge as it
 *     lifts (drawn length × cos(tilt)), revealing its dark underside end-face and
 *     casting a lengthening shadow — the lift read from above;
 *   - the COUNTERWEIGHT (the opposite, shorter arm) foreshortens the SAME way, so
 *     the whole assembly pulls in toward the pivot as it rises (both ends tilt out
 *     of the ground plane together);
 *   - a steel BEARING SEAT sits across the track at the pivot (and a landing seat
 *     at the far gap edge), each on a low timber footing — machinery seen from
 *     directly above, no elevation-only columns or masts.
 *
 * Pure presentation: SVG only, no sim, no state. The caller passes the span
 * endpoints, the rail Y, and the live `raise` it read off its `LinkActuator`.
 */

/** Max tilt the leaf reaches at full raise, degrees. Drives the plan-view
 *  foreshortening (drawn length × cos(tilt)) of BOTH seesaw arms. */
const MAX_TILT_DEG = 75;
/** Half-width of the wooden deck band (matches the approach plank stroke). */
const DECK_HALF_W = 7;

/** Foreshortening of a seesaw arm of full length `full` at raise `r`: full when
 *  flat (in the ground plane), shrinking toward the hinge as it tilts up/down. */
function drawnArm(full: number, r: number): number {
  return full * Math.cos((r * MAX_TILT_DEG * Math.PI) / 180);
}

/** A bearing seat across the track — in plan view, the steel axle the leaf pivots
 *  on (at the hinge) or the seat it lands on (at the far gap edge), each on a low
 *  timber footing straddling the rails. Reads as machinery from directly above. */
function BearingSeat({ x, y }: { x: number; y: number }) {
  return (
    <g data-testid="lift-bridge-bearing">
      {/* Timber footing pad straddling the track. */}
      <rect
        x={x - 10}
        y={y - 19}
        width={20}
        height={38}
        rx={3}
        fill="url(#tf-pier)"
        stroke="#5d3f1c"
        strokeWidth={1.2}
      />
      {/* The steel axle / landing bar across the rails. */}
      <rect
        x={x - 6}
        y={y - 15}
        width={12}
        height={30}
        rx={2}
        fill="#8a929b"
        stroke="#4a4f55"
        strokeWidth={1.6}
      />
      {/* A rivet line down the bar's centre. */}
      <line x1={x} y1={y - 12} x2={x} y2={y + 12} stroke="#5b626a" strokeWidth={1.4} />
    </g>
  );
}

/** The liftable leaf, drawn at its REAL raise fraction `r` (0 down … 1 up). It is
 *  track, so it stays wooden (ADR-024 §4). The hinge is at the NEAR (left) gap
 *  edge; the free (right) end tilts up. In top-down we fake the lift by
 *  FORESHORTENING the plank toward its hinge, revealing the dark underside
 *  end-face and casting a lengthening shadow. */
function Leaf({ hingeX, freeX, y, r }: { hingeX: number; freeX: number; y: number; r: number }) {
  const drawnLen = drawnArm(freeX - hingeX, r);
  const tipX = hingeX + drawnLen;
  /* The raised deck floats on a longer cast shadow, offset down-right. */
  const shadowOff = r * 18;
  return (
    <g data-testid="lift-bridge-span" data-span-raise={r.toFixed(3)}>
      {r > 0.02 && (
        <line
          x1={hingeX}
          y1={y + shadowOff}
          x2={tipX}
          y2={y + shadowOff}
          stroke="rgba(63,43,19,0.28)"
          strokeWidth={2 * DECK_HALF_W}
          strokeLinecap="round"
        />
      )}
      {/* The wooden deck band, foreshortened toward the hinge. */}
      <line x1={hingeX} y1={y} x2={tipX} y2={y} stroke="#cba460" strokeWidth={2 * DECK_HALF_W} />
      <line x1={hingeX} y1={y} x2={tipX} y2={y} stroke="#6f4c28" strokeWidth={2.6} />
      {/* The dark underside end-face, revealed as the free end tilts up. */}
      {r > 0.02 && (
        <rect
          x={tipX - 3}
          y={y - 8}
          width={Math.max(2, r * 10)}
          height={16}
          fill="#3a2c1a"
          stroke="#241a10"
          strokeWidth={1}
        />
      )}
    </g>
  );
}

/** The COUNTERWEIGHT arm — the seesaw's other side, reaching BACK over the near
 *  approach from the hinge and ending in a heavy block. It foreshortens toward the
 *  hinge exactly as the leaf does (both arms tilt out of the plane together), so as
 *  the leaf rises the weight is drawn pulling in toward the pivot — the bascule
 *  balance, read from above. Steel arm + dark cast block. */
function Counterweight({
  hingeX,
  y,
  full,
  r,
}: { hingeX: number; y: number; full: number; r: number }) {
  const drawn = drawnArm(full, r);
  const tailX = hingeX - drawn;
  return (
    <g data-testid="lift-bridge-counterweight">
      {/* The balance arm from the pivot back to the weight. */}
      <line
        x1={hingeX}
        y1={y}
        x2={tailX}
        y2={y}
        stroke="#7a838f"
        strokeWidth={8}
        strokeLinecap="round"
      />
      <line x1={hingeX} y1={y} x2={tailX} y2={y} stroke="#4c545d" strokeWidth={2} />
      {/* The counterweight block at the tail end. */}
      <rect
        x={tailX - 11}
        y={y - 12}
        width={22}
        height={24}
        rx={2}
        fill="#5a6470"
        stroke="#39414b"
        strokeWidth={1.6}
      />
      <line x1={tailX - 11} y1={y} x2={tailX + 11} y2={y} stroke="#39414b" strokeWidth={1.2} />
    </g>
  );
}

export interface LiftBridgeArtProps {
  /** Near gap edge (the hinge / the start of the liftable leaf). */
  readonly hingeX: number;
  /** Far gap edge (the free end of the leaf when down). */
  readonly freeX: number;
  /** The rail centre-line Y the deck and approaches sit on. */
  readonly y: number;
  /** The actuator's REAL raise fraction (0 down … 1 up) — read off, never animated. */
  readonly raise: number;
}

/**
 * The whole bridge in plan view: a soft recess shadow in the gap (generic ground,
 * no waterway implied), the pivot + landing bearing seats across the track, the
 * counterweight seesaw arm behind the hinge, and the liftable leaf — all drawn at
 * the real raise fraction. Drawn BENEATH the approach rails + bodies by the caller,
 * except the leaf which the caller layers last.
 */
export function LiftBridgeArt({ hingeX, freeX, y, raise }: LiftBridgeArtProps) {
  return (
    <g data-testid="lift-bridge-art">
      {/* A soft recess shadow in the gap so the break reads as a drop, with no
          waterway implied — generic ground. */}
      <rect
        x={hingeX - 4}
        y={y - DECK_HALF_W - 3}
        width={freeX - hingeX + 8}
        height={2 * DECK_HALF_W + 6}
        rx={3}
        fill="rgba(63,43,19,0.18)"
      />
      {/* The counterweight (beneath the leaf, so the leaf reads on top at the hinge). */}
      <Counterweight hingeX={hingeX} y={y} full={(freeX - hingeX) * 0.42} r={raise} />
      {/* Pivot bearing at the hinge, landing seat at the far gap edge. */}
      <BearingSeat x={hingeX} y={y} />
      <BearingSeat x={freeX} y={y} />
      {/* The liftable leaf, last, at the real raise fraction. */}
      <Leaf hingeX={hingeX} freeX={freeX} y={y} r={raise} />
    </g>
  );
}
