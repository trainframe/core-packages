/**
 * Shared lift-bridge art (ADR-024 wood/workshop aesthetic), drawn purely from the
 * geometry + the actuator's REAL raise fraction — never animated, never reading
 * ground truth. Both the controlled `LiftBridgeScenarioView` and the contrasting
 * `BridgeRunoffScenarioView` render this SAME component so the two demos are
 * visually identical; only the behaviour (a train held vs. a train running off)
 * differs.
 *
 * It reads as a real bascule/lift bridge: masonry/timber PIERS (the towers the
 * leaf pivots against) flank the span, with stone abutments where the fixed
 * approaches meet the piers, a lift-tower hint + counterweight on the hinge pier,
 * the steel pivot bosses, the dark water in the channel beneath, and a cast
 * shadow that lengthens as the leaf rises. The raised leaf is FORESHORTENED toward
 * its hinge (plan-view cos of the tilt) so the lift reads from above — the same
 * trick the toy-table lift bridge uses (`LIFT_BRIDGE_FORESHORTEN`).
 *
 * Pure presentation: SVG only, no sim, no state. The caller passes the span
 * endpoints, the rail Y, and the live `raise` it read off its `LinkActuator`.
 */

/** Max tilt the leaf reaches at full raise, degrees. Drives the plan-view
 *  foreshortening (drawn length × cos(tilt)) so the deck compresses toward the
 *  hinge as it lifts. */
const MAX_TILT_DEG = 75;
/** Half-width of the wooden deck band (matches the approach plank stroke). */
const DECK_HALF_W = 7;

interface PierBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A masonry/timber pier: a coursed-stone tower the leaf pivots on / rests
 *  against. Drawn as a recessed wood column (the `tf-pier` gradient — darker,
 *  in-shadow wood than the deck) with horizontal courses routed across it and a
 *  capping stone, so it reads as the standing support beneath the deck. */
function Pier({ box }: { box: PierBox }) {
  const { x, y, w, h } = box;
  const courses = Math.max(2, Math.round(h / 22));
  const lines: string[] = [];
  for (let i = 1; i < courses; i++) {
    const ly = y + (h * i) / courses;
    lines.push(`M${x + 3} ${ly} L${x + w - 3} ${ly}`);
  }
  return (
    <g data-testid="lift-bridge-pier">
      {/* Contact shadow the pier casts onto the bank. */}
      <rect x={x + 3} y={y + h - 2} width={w} height={8} rx={3} fill="rgba(63,43,19,0.22)" />
      {/* The pier column, in-shadow wood. */}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={3}
        fill="url(#tf-pier)"
        stroke="#5d3f1c"
        strokeWidth={1.4}
      />
      {/* A soft rim light down the lit (left) edge for a bevelled, raised feel. */}
      <line
        x1={x + 2}
        y1={y + 3}
        x2={x + 2}
        y2={y + h - 3}
        stroke="#d8b070"
        strokeOpacity={0.5}
        strokeWidth={2}
      />
      {/* Routed stone courses. */}
      <path
        d={lines.join(' ')}
        fill="none"
        stroke="#4a3216"
        strokeOpacity={0.55}
        strokeWidth={1.2}
      />
      {/* The capping stone the deck seats against. */}
      <rect
        x={x - 3}
        y={y - 6}
        width={w + 6}
        height={9}
        rx={2}
        fill="#9a6c2c"
        stroke="#5d3f1c"
        strokeWidth={1.2}
      />
    </g>
  );
}

/** The liftable leaf, drawn at its REAL raise fraction `r` (0 down … 1 up). It is
 *  track, so it stays wooden (ADR-024 §4). The hinge is at the NEAR (left) gap
 *  edge; the free (right) end tilts up. In top-down we fake the lift by
 *  FORESHORTENING the plank toward its hinge (drawn length × cos(tilt)),
 *  revealing the dark underside end-face and casting a lengthening shadow. */
function Leaf({ hingeX, freeX, y, r }: { hingeX: number; freeX: number; y: number; r: number }) {
  const full = freeX - hingeX;
  const tiltRad = (r * MAX_TILT_DEG * Math.PI) / 180;
  const drawnLen = full * Math.cos(tiltRad);
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
      {/* The pivot fitting — a steel boss at the hinge. */}
      <circle cx={hingeX} cy={y} r={5} fill="#8a929b" stroke="#4a4f55" strokeWidth={1.5} />
    </g>
  );
}

/** The hinge-pier's lift gear: a short steel tower above the pivot carrying a
 *  COUNTERWEIGHT that descends as the leaf rises (a bascule's balance), with a
 *  tie line back to the leaf root — a hint of the lifting mechanism. */
function LiftTower({ pierX, deckY, r }: { pierX: number; deckY: number; r: number }) {
  const towerTop = deckY - 70;
  /* The counterweight rides down its guide as the leaf goes up. */
  const cwY = towerTop + 14 + r * 30;
  return (
    <g data-testid="lift-bridge-tower">
      {/* The steel mast above the pivot pier. */}
      <rect
        x={pierX - 5}
        y={towerTop}
        width={10}
        height={deckY - towerTop}
        fill="#7a838f"
        stroke="#4c545d"
        strokeWidth={1.6}
      />
      {/* The cross-head the counterweight hangs from. */}
      <rect
        x={pierX - 16}
        y={towerTop - 4}
        width={32}
        height={8}
        rx={2}
        fill="#6b7480"
        stroke="#444c55"
        strokeWidth={1.4}
      />
      {/* The counterweight block, lower when the leaf is higher. */}
      <rect
        x={pierX - 12}
        y={cwY}
        width={24}
        height={18}
        rx={2}
        fill="#5a6470"
        stroke="#39414b"
        strokeWidth={1.6}
      />
      {/* The tie/guide line from the cross-head down to the weight. */}
      <line x1={pierX} y1={towerTop} x2={pierX} y2={cwY} stroke="#39414b" strokeWidth={2} />
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
 * The whole bridge: two short support piers at the gap edges, the lift tower +
 * counterweight on the hinge pier, and the liftable leaf drawn at the real raise
 * fraction over a soft recess shadow (generic ground, no waterway implied). Drawn
 * BENEATH the approach rails + bodies by the caller, except the leaf which the
 * caller layers last.
 */
export function LiftBridgeArt({ hingeX, freeX, y, raise }: LiftBridgeArtProps) {
  /* Pier footprint: each tower stands just below its gap edge as a support — kept
   *  SHORT (not a deep wall) so the piece stays generic, not a waterway crossing. */
  const pierW = 28;
  const pierTop = y + DECK_HALF_W + 2;
  const pierH = 58;
  const nearPier: PierBox = { x: hingeX - pierW / 2, y: pierTop, w: pierW, h: pierH };
  const farPier: PierBox = { x: freeX - pierW / 2, y: pierTop, w: pierW, h: pierH };
  return (
    <g data-testid="lift-bridge-art">
      {/* A soft recess shadow in the gap so the break reads as a drop, with no
          waterway implied — generic ground, not a canal. */}
      <rect
        x={hingeX - 4}
        y={y - DECK_HALF_W - 3}
        width={freeX - hingeX + 8}
        height={2 * DECK_HALF_W + 6}
        rx={3}
        fill="rgba(63,43,19,0.18)"
      />
      {/* The two support piers at the gap edges. */}
      <Pier box={nearPier} />
      <Pier box={farPier} />
      {/* The lift tower + counterweight on the hinge (near) pier. */}
      <LiftTower pierX={hingeX} deckY={y} r={raise} />
      {/* The liftable leaf, last, at the real raise fraction. */}
      <Leaf hingeX={hingeX} freeX={freeX} y={y} r={raise} />
    </g>
  );
}
