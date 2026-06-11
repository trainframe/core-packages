import { useCallback, useEffect, useRef, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerClient } from '../broker/client.js';
import { encodeDeviceEvent } from '../broker/encode-event.js';
import { buildBridgeDemo } from '../demo/bridge-demo.js';
import { buildRailyardDemo } from '../demo/railyard-demo.js';
import { nearestStartEdge } from '../sim/nearest-edge.js';
import type { ToyHardware } from '../sim/toy-hardware.js';
import { useToyHardware } from '../sim/use-toy-hardware.js';
import { CARRIAGE_SPACING_MM, type WorldPosition, computeTrainTrails } from '../track/coupling.js';
import { type EdgePath, composeEdgePath } from '../track/edge-path.js';
import { SNAP_DISTANCE, compileLayout } from '../track/layout-from-pieces.js';
import { detectSameLayerOverlaps, pierSuppressed } from '../track/overlap.js';
import {
  CARRIAGE_COLOR_IDS,
  CRANE_GANTRY_X_MM,
  CRANE_INITIAL_CRATES,
  CRANE_REACH_MM,
  CRANE_STACK_SLOTS,
  CRANE_TROLLEY_REST_Y_MM,
  type CarriageColorId,
  type DevicePieceType,
  LIFT_BRIDGE_FORESHORTEN,
  LIFT_BRIDGE_PIVOT,
  LIFT_BRIDGE_SPAN_HALF_MM,
  PIECE_LABELS,
  PIECE_TINT,
  type PieceFeature,
  RAILYARD_GANTRY_X,
  RAILYARD_HEAD_Y,
  RAILYARD_RAIL_Y,
  RAILYARD_SLOT_YS,
  type RailyardJourney,
  type RotationDeg,
  type SupportColumn,
  TOYBOX_TRAYS,
  TRAIN_LENGTH_MM,
  TURNTABLE_POSITIONS,
  TURNTABLE_POSITION_ANGLE_DEG,
  type TrackPiece,
  type TrackPieceType,
  VISION_LED,
  VISION_SENSOR_RANGE_MM,
  carriageCratePath,
  craneCratePath,
  craneTrolley,
  getEndpoints,
  getPieceShape,
  isDevicePiece,
  isWireDevice,
  layerOf,
  layerStyle,
  liftBridgeEndPlate,
  liftBridgeGap,
  liftBridgeSpan,
  pieceMarkerKind,
  railyardInteriorJourney,
  supportColumn,
  turntableDeck,
  worldHalfPath,
} from '../track/pieces.js';
import {
  computeMovePlacement,
  computePlacement,
  nearestConnectablePoint,
} from '../track/placement.js';
import { ConnectionStatus } from './ConnectionStatus.js';
import { ScanBox } from './ScanBox.js';
import { Settings } from './Settings.js';

// Canvas scale: 1 mm = SCALE px. Matches the old TrackBuilder so coordinates
// translate one-for-one across the refactor.
const SCALE = 2;
const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;

/** Minimum and maximum zoom levels. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

/** MIME type for pieces being dragged from the toybox onto the canvas. */
const TOYBOX_DRAG_MIME = 'application/x-trainframe-toybox-type';

/**
 * The garage device id used by the toy-table when announcing tag bindings.
 * Real hardware uses the same id — per ADR-013 the sim must be
 * indistinguishable from physical kit on the wire.
 */
const GARAGE_DEVICE_ID = 'GARAGE';

/**
 * Device body colours (train/gate/carriage are NOT wooden). Track pieces are
 * filled with the beech-wood gradient + their `PIECE_TINT` wash instead, so they
 * have no entry here. Keyed by the exhaustive `DevicePieceType`, so adding a
 * device forces a colour here — there is no silent grey fallback.
 */
const DEVICE_FILL: Record<DevicePieceType, string> = {
  train: '#cf4436',
  carriage: '#3f6fa6',
  gate: '#8a929c',
};

/**
 * Carriage liveries (ADR-024 §4 — devices keep solid body colours; the palette
 * lives here, not in the geometry module). A carriage with no `colorId` keeps
 * `DEVICE_FILL.carriage`; these are the named liveries the toybox swatches
 * offer. Chosen to stay legible against the warm wood and distinct from the red
 * locomotive (`DEVICE_FILL.train`).
 */
const CARRIAGE_COLORS: Record<CarriageColorId, string> = {
  red: '#c0392b',
  green: '#3f8f54',
  amber: '#d99a1c',
  blue: '#3f6fa6',
  purple: '#8c5bb0',
};

/** Body fill for a carriage piece: its intrinsic livery, or the default blue. */
function carriageFill(piece: TrackPiece): string {
  return piece.colorId !== undefined ? CARRIAGE_COLORS[piece.colorId] : DEVICE_FILL.carriage;
}

/* SVG gradient/fill ids defined once in the page <defs>; referenced by url(). */
const WOOD_FILL = 'url(#tf-wood)';

/** A soft, near-omnidirectional contact shadow under every piece (rotation- and
 * flip-invariant: the offset is tiny so a rotated plank's shadow never swings
 * out). Composed with the selection/overlap glow into one CSS `filter`. */
const CONTACT_SHADOW = 'drop-shadow(0 1px 1.4px rgba(63,43,19,0.34))';

/** The composed CSS `filter` for a piece group: contact shadow, plus a coloured
 * glow for an invalid same-layer overlap (red, wins) or selection (blue). A glow
 * — not a stroke — so multi-plank pieces (junction, crossing) never show an
 * internal seam where their sub-paths meet. */
function pieceFilter(invalidOverlap: boolean, selected: boolean): string {
  if (invalidOverlap) {
    return `${CONTACT_SHADOW} drop-shadow(0 0 1px #dc2626) drop-shadow(0 0 4px #dc2626)`;
  }
  if (selected) {
    return `${CONTACT_SHADOW} drop-shadow(0 0 1px #2563eb) drop-shadow(0 0 4px #2563eb)`;
  }
  return CONTACT_SHADOW;
}

/** Render one piece feature (platform, buffer, window, lamp, boom, chevron) by
 * its semantic role. The palette lives here, with the rest of the wood theme. */
function Feature({ feature }: { feature: PieceFeature }) {
  switch (feature.role) {
    case 'platform':
      return <path d={feature.d} fill="url(#tf-platwood)" stroke="#b08c54" strokeWidth={0.8} />;
    case 'dark-wood':
      return <path d={feature.d} fill="#6b4a2a" />;
    case 'glass':
      return (
        <path d={feature.d} fill="#bcdcea" fillOpacity={0.9} stroke="#5d7f8e" strokeWidth={0.8} />
      );
    case 'metal':
      return <path d={feature.d} fill="#aab2bc" stroke="#717a85" strokeWidth={0.6} />;
    case 'pop':
      return <path d={feature.d} fill="#ffd24a" stroke="#caa033" strokeWidth={0.6} />;
    case 'danger':
      return <path d={feature.d} fill="#d8413a" />;
    case 'line':
      return (
        <path
          d={feature.d}
          fill="none"
          stroke="#4a3216"
          strokeWidth={feature.width ?? 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}

/** The two routed rail grooves: a lighter wall stroke over a deep centre
 * channel, so each groove reads as recessed into the plank. */
function Groove({ d }: { d: string }) {
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke="#6f4c28"
        strokeWidth={2.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={d}
        fill="none"
        stroke="#3a2611"
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

/**
 * Live visual state for an experimental piece's MOVING parts (docs/experimental
 * 001–005). Derived from the simulation each render — the sim is the single
 * source of truth (a switch's confirmed position, a gate's withhold), so the
 * drawn state can never lie about the wire state.
 */
type ExperimentVisual =
  | { readonly kind: 'turntable'; readonly angleDeg: number }
  | { readonly kind: 'lift-bridge'; readonly raised: boolean }
  | { readonly kind: 'vision-station'; readonly lit: boolean }
  | { readonly kind: 'crane-station'; readonly crates: number; readonly trolleyOverRail: boolean }
  | { readonly kind: 'cargo' };

/** Rest-state visual for a piece type — what a tray preview or an un-scanned
 * piece shows: deck east, span seated, LED dark, full crate stack. Undefined
 * for pieces with no moving parts. */
function restingExperimentVisual(type: TrackPieceType): ExperimentVisual | undefined {
  if (type === 'turntable') return { kind: 'turntable', angleDeg: 0 };
  if (type === 'lift-bridge') return { kind: 'lift-bridge', raised: false };
  if (type === 'vision-station') return { kind: 'vision-station', lit: false };
  if (type === 'crane-station') {
    return { kind: 'crane-station', crates: CRANE_INITIAL_CRATES, trolleyOverRail: false };
  }
  return undefined;
}

/** A wooden moving sub-shape (turntable deck, bridge span): rim light behind
 * the wood fill (matching PieceBody), optional tint wash, grooves, features. */
function MovingWood({
  shape,
  tint,
}: {
  readonly shape: {
    readonly svgPath: string;
    readonly grooves: ReadonlyArray<string>;
    readonly features: ReadonlyArray<PieceFeature>;
  };
  readonly tint: string | null;
}) {
  return (
    <>
      <path d={shape.svgPath} fill="none" stroke="#f6e8c9" strokeOpacity={0.55} strokeWidth={2} />
      <path d={shape.svgPath} fill={WOOD_FILL} />
      {tint !== null && <path d={shape.svgPath} fill={tint} fillOpacity={0.22} />}
      {shape.grooves.map((g) => (
        <Groove key={g} d={g} />
      ))}
      {shape.features.map((f) => (
        <Feature key={f.d} feature={f} />
      ))}
    </>
  );
}

/**
 * The lift bridge's hinged span — the LIFT, seen from above. The leaf doesn't
 * swing or slide: while raised its plan-view length compresses toward the
 * hinge (scale about the pivot), it floats on a longer cast shadow, its dark
 * underside end face comes into view at the free end, and the gap opens
 * beyond it — "there is literally no rail here right now".
 */
function LiftBridgeSpanPart({ pieceId, raised }: { pieceId: string; raised: boolean }) {
  return (
    <g data-testid={`bridge-span-${pieceId}`} data-raised={raised ? 'true' : 'false'}>
      {/* The void under the span — near-black, well below the groove-channel
          dark, faded in while the deck is up so the missing rail reads as a
          hole in the world rather than another plank. */}
      <path
        d={liftBridgeGap()}
        fill="#241608"
        opacity={raised ? 0.92 : 0}
        style={{ transition: 'opacity 600ms ease' }}
      />
      <g
        style={{
          transform: `scaleX(${raised ? LIFT_BRIDGE_FORESHORTEN : 1})`,
          transformOrigin: `${LIFT_BRIDGE_PIVOT.x}px ${LIFT_BRIDGE_PIVOT.y}px`,
          transition: 'transform 900ms ease-in-out',
          filter: raised ? 'drop-shadow(5px 9px 5px rgba(63, 43, 19, 0.5))' : undefined,
        }}
      >
        <MovingWood shape={liftBridgeSpan()} tint={PIECE_TINT['lift-bridge']} />
      </g>
      {/* The deck's underside end face, visible only once the leaf tilts
          toward the viewer. It rides OUTSIDE the foreshortened group (the
          face gets nearer, not thinner), translated to the free end. */}
      <path
        d={liftBridgeEndPlate()}
        fill="#8a6132"
        opacity={raised ? 1 : 0}
        style={{
          transform: `translateX(${
            raised ? -(1 - LIFT_BRIDGE_FORESHORTEN) * 2 * LIFT_BRIDGE_SPAN_HALF_MM : 0
          }px)`,
          transition: 'transform 900ms ease-in-out, opacity 600ms ease',
        }}
      />
    </g>
  );
}

/**
 * The crane's moving parts (experimental 003): the trackside crate stack —
 * one crate per held slot, growing and shrinking as the hook works wagons —
 * and the TROLLEY, the travelling arm. The trolley rides the beam: parked
 * over the stack at rest, it slides out over the rail whenever a wagon is
 * under the gantry (the design doc's trolley-along-the-cross-beam motion),
 * so cause and effect read from the table: wagon arrives, the arm comes over.
 */
function CranePart({
  pieceId,
  crates,
  trolleyOverRail,
}: {
  pieceId: string;
  crates: number;
  trolleyOverRail: boolean;
}) {
  return (
    <g data-testid={`crane-stack-${pieceId}`} data-crates={crates}>
      {CRANE_STACK_SLOTS.slice(0, crates).map((slot) => (
        <Feature
          key={`${slot.x},${slot.y}`}
          feature={{ role: 'pop', d: craneCratePath(slot.x, slot.y) }}
        />
      ))}
      <g
        data-testid={`crane-trolley-${pieceId}`}
        data-over-rail={trolleyOverRail ? 'true' : 'false'}
        style={{
          transform: `translateY(${trolleyOverRail ? 0 : CRANE_TROLLEY_REST_Y_MM}px)`,
          transition: 'transform 700ms ease-in-out',
        }}
      >
        {craneTrolley().map((f) => (
          <Feature key={f.d} feature={f} />
        ))}
      </g>
    </g>
  );
}

/**
 * The moving / lit parts of an experimental piece, drawn OVER its static body
 * inside the piece's transformed group (so they rotate/flip with it):
 *  - turntable: the bridge deck swings to the confirmed stub angle — the
 *    branch choice as a visible angle, eased like a deck seating.
 *  - lift bridge: the hinged span lifts (foreshortens toward its hinge) over
 *    the opening gap.
 *  - crane: the trackside crate stack, drawn from the live count.
 *  - cargo: the crate riding a laden wagon's back.
 *  - vision station: the detection LED lights while a train is under the
 *    sensor; this device is defined by stillness, so that is its only motion.
 */
function ExperimentParts({
  pieceId,
  visual,
}: {
  pieceId: string;
  visual: ExperimentVisual | undefined;
}) {
  if (visual === undefined) return null; // not an experimental piece
  switch (visual.kind) {
    case 'turntable':
      return (
        <g
          data-testid={`turntable-deck-${pieceId}`}
          data-angle={visual.angleDeg}
          style={{
            transform: `rotate(${visual.angleDeg}deg)`,
            transition: 'transform 900ms ease-in-out',
          }}
        >
          <MovingWood shape={turntableDeck()} tint={null} />
        </g>
      );
    case 'lift-bridge':
      return <LiftBridgeSpanPart pieceId={pieceId} raised={visual.raised} />;
    case 'crane-station':
      return (
        <CranePart
          pieceId={pieceId}
          crates={visual.crates}
          trolleyOverRail={visual.trolleyOverRail}
        />
      );
    case 'cargo':
      // The crate riding a laden wagon's back — visibly one box heavier.
      return (
        <g data-testid={`cargo-${pieceId}`}>
          <Feature feature={{ role: 'pop', d: carriageCratePath() }} />
          <Feature feature={{ role: 'line', width: 1.4, d: 'M 0 -6 V 6' }} />
        </g>
      );
    case 'vision-station':
      return (
        <g data-testid={`vision-led-${pieceId}`} data-lit={visual.lit ? 'true' : 'false'}>
          {visual.lit && (
            <>
              <circle cx={VISION_LED.x} cy={VISION_LED.y} r={5} fill="#ffd24a" opacity={0.35} />
              <circle
                cx={VISION_LED.x}
                cy={VISION_LED.y}
                r={2.2}
                fill="#ffd24a"
                stroke="#caa033"
                strokeWidth={0.6}
              />
            </>
          )}
        </g>
      );
  }
}

/**
 * The painted body of a piece: the wooden plank (or coloured device body), its
 * functional tint wash, a soft rim light, the routed rail grooves, and any
 * feature overlays — dimmed together when the piece is an inert device. The
 * power dot is rendered by the parent OUTSIDE this group so it keeps its status
 * colour. Extracted so `PieceRenderer` stays under the complexity budget.
 */
function PieceBody({
  shape,
  bodyFill,
  tint,
  isDevice,
  dim,
}: {
  readonly shape: ReturnType<typeof getPieceShape>;
  readonly bodyFill: string;
  readonly tint: string | null;
  readonly isDevice: boolean;
  readonly dim: number;
}) {
  return (
    <g opacity={dim}>
      {/* Soft rim light for a bevelled, raised feel — drawn BEHIND the fill so the
          opaque wood covers the internal seams of multi-plank pieces (junction,
          crossing); only the outer silhouette edge shows. */}
      <path
        d={shape.svgPath}
        fill="none"
        stroke={isDevice ? '#ffffff' : '#f6e8c9'}
        strokeOpacity={isDevice ? 0.3 : 0.55}
        strokeWidth={2}
      />
      {/* Wooden plank (or device body). */}
      <path d={shape.svgPath} fill={bodyFill} />
      {/* Gentle functional colour wash over the wood (track pieces only). */}
      {!isDevice && tint !== null && <path d={shape.svgPath} fill={tint} fillOpacity={0.22} />}
      {/* Routed rail grooves, derived from the rail a train rides. */}
      {shape.grooves.map((g) => (
        <Groove key={g} d={g} />
      ))}
      {/* Detail overlays (platform, buffer, windows, lamps, boom…). */}
      {shape.features.map((f) => (
        <Feature key={f.d} feature={f} />
      ))}
    </g>
  );
}

/** Shared SVG defs (wood gradients) for the canvas. The contact/selection
 * shadows are CSS `filter`s, so the only defs needed are the fill gradients. */
function WoodDefs() {
  return (
    <defs>
      <linearGradient id="tf-wood" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#e7c084" />
        <stop offset="0.5" stopColor="#d2a45e" />
        <stop offset="1" stopColor="#b07e3c" />
      </linearGradient>
      <linearGradient id="tf-platwood" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#eed7a8" />
        <stop offset="1" stopColor="#cda878" />
      </linearGradient>
      {/* The support pier: a darker, in-shadow wood than the deck above it, so a
        raised piece's column recedes and reads as standing under the deck. */}
      <linearGradient id="tf-pier" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#a8732f" />
        <stop offset="1" stopColor="#7a5523" />
      </linearGradient>
    </defs>
  );
}

const POWER_DOT_RADIUS = 6;

let pieceCounter = 0;
function nextPieceId(prefix: string): string {
  pieceCounter += 1;
  return `${prefix}-${pieceCounter}`;
}

function nextRotation(r: RotationDeg): RotationDeg {
  const next = (r + 45) % 360;
  return next as RotationDeg;
}

/** Device id for a piece's *own* device announcement. Only meaningful for
 * wire-visible devices (train / gate). Callers must guard on `isWireDevice`
 * before calling — carriages are device pieces but have no MQTT identity. */
function deviceIdForDevicePiece(piece: TrackPiece): string {
  if (piece.type === 'train') return `T-${piece.id}`;
  if (piece.type === 'gate') return `GATE-${piece.id}`;
  if (piece.type === 'railyard') return `YARD-${piece.id}`;
  // Unreachable: callers gate on isWireDevice. Keeping the throw makes the
  // contract explicit for future maintainers.
  throw new Error(`deviceIdForDevicePiece called on non-wire-device piece ${piece.type}`);
}

/**
 * Extract the piece id from a marker id of the form `M-{pieceId}`.
 * Returns undefined when the id doesn't match the expected prefix.
 */
function pieceIdFromMarkerId(markerId: string): string | undefined {
  return markerId.startsWith('M-') ? markerId.slice(2) : undefined;
}

/**
 * Attempt to resolve the edge endpoints for a given sim train. Returns
 * `undefined` when the train is deferred (no current edge) or when either
 * endpoint marker can't be matched to a placed piece.
 */
function resolveEdgeEndpoints(
  simTrain: { getCurrentEdge(): { from_marker_id: string; to_marker_id: string } | null },
  piecesById: ReadonlyMap<string, TrackPiece>,
):
  | {
      fromPiece: TrackPiece;
      toPiece: TrackPiece;
      fromMarkerId: string;
      toMarkerId: string;
    }
  | undefined {
  const edge = simTrain.getCurrentEdge();
  if (edge === null) return undefined;
  const fromPieceId = pieceIdFromMarkerId(edge.from_marker_id);
  const toPieceId = pieceIdFromMarkerId(edge.to_marker_id);
  if (fromPieceId === undefined || toPieceId === undefined) return undefined;
  const fromPiece = piecesById.get(fromPieceId);
  const toPiece = piecesById.get(toPieceId);
  if (fromPiece === undefined || toPiece === undefined) return undefined;
  return {
    fromPiece,
    toPiece,
    fromMarkerId: edge.from_marker_id,
    toMarkerId: edge.to_marker_id,
  };
}

/** Round a heading (deg, clockwise from east) to the nearest `RotationDeg`. */
function toRotationDeg(deg: number): RotationDeg {
  return ((((Math.round(deg / 45) * 45) % 360) + 360) % 360) as RotationDeg;
}

/**
 * The static orientation for a TRAIN snapped onto `position`, so the parked
 * sprite already faces the way it will travel when powered on — removing the
 * one-time heading "pop" at go-live.
 *
 * Uses the SAME selector the simulator uses to spawn (`nearestStartEdge` over
 * `compileLayout`), so there is no parallel selector to drift: the spawn edge's
 * d=0 heading from the true composite rail path is rounded to the nearest 45°.
 * Returns `undefined` (caller keeps current rotation) when no edge originates
 * near the position — exactly when the simulator would defer the spawn.
 *
 * The 45° quantisation means a curve's ~22.5° d=0 tangent still leaves a small,
 * acceptable rotation on power-on (the live path is sampled exactly then).
 */
function spawnOrientationDeg(
  position: { readonly x: number; readonly y: number },
  pieces: ReadonlyArray<TrackPiece>,
): RotationDeg | undefined {
  const layout = compileLayout(pieces, 'orient');
  const startEdge = nearestStartEdge(layout, position);
  if (startEdge === undefined) return undefined;
  const fromId = startEdge.from_marker_id.startsWith('M-')
    ? startEdge.from_marker_id.slice(2)
    : undefined;
  const toId = startEdge.to_marker_id.startsWith('M-')
    ? startEdge.to_marker_id.slice(2)
    : undefined;
  if (fromId === undefined || toId === undefined) return undefined;
  const fromPiece = pieces.find((p) => p.id === fromId);
  const toPiece = pieces.find((p) => p.id === toId);
  if (fromPiece === undefined || toPiece === undefined) return undefined;
  return toRotationDeg(composeEdgePath(fromPiece, toPiece).at(0).headingDeg);
}

/** Sample a composite edge path at distance `d`, returning a `WorldPosition`
 * (the path's heading is already in the SVG clockwise-from-east convention). */
function poseAt(path: EdgePath, d: number): WorldPosition {
  const clamped = Math.max(0, Math.min(d, path.length));
  const pose = path.at(clamped);
  return { x: pose.x, y: pose.y, rotationDeg: pose.headingDeg };
}

/**
 * The minimal structural seam `trailingCarriagePose` needs from a sim train.
 * `VirtualTrain` satisfies it structurally — no cast required.
 */
export interface TrailingPositionSource {
  getTrailingPosition(offset_mm: number): {
    edge: { from_marker_id: string; to_marker_id: string };
    distance_into_edge_mm: number;
  } | null;
}

/**
 * Resolve the world pose for a trailing carriage at `offset_mm` behind the
 * head. Walks back through the sim's traversal history via `getTrailingPosition`
 * and maps the resulting (edge, distance_into_edge_mm) to a world-space pose.
 *
 * The path cache is keyed by `${from_marker_id}->${to_marker_id}` and should
 * be seeded with the train's current-edge path before the carriage loop so
 * current-edge carriages hit the cache rather than recomposing.
 *
 * Returns `undefined` when:
 *   - `getTrailingPosition` returns null (train off track),
 *   - either endpoint marker cannot be mapped to a `TrackPiece` in `piecesById`.
 *
 * The `estimatedLengthMm` callback resolves each edge's declared physical
 * length so the sim-space mm → world-path-fraction rescaling stays correct.
 *
 * @pure (given a stable cache — mutates the cache for memoisation only)
 */
export function trailingCarriagePose(
  simTrain: TrailingPositionSource,
  offset_mm: number,
  piecesById: ReadonlyMap<string, TrackPiece>,
  estimatedLengthMm: (fromMarkerId: string, toMarkerId: string) => number,
  pathCache: Map<string, EdgePath>,
): WorldPosition | undefined {
  const pos = simTrain.getTrailingPosition(offset_mm);
  if (pos === null) return undefined;

  const { edge, distance_into_edge_mm } = pos;
  const cacheKey = `${edge.from_marker_id}->${edge.to_marker_id}`;

  let path = pathCache.get(cacheKey);
  if (path === undefined) {
    const fromPieceId = pieceIdFromMarkerId(edge.from_marker_id);
    const toPieceId = pieceIdFromMarkerId(edge.to_marker_id);
    if (fromPieceId === undefined || toPieceId === undefined) return undefined;
    const fromPiece = piecesById.get(fromPieceId);
    const toPiece = piecesById.get(toPieceId);
    if (fromPiece === undefined || toPiece === undefined) return undefined;
    path = composeEdgePath(fromPiece, toPiece);
    pathCache.set(cacheKey, path);
  }

  const estLen = estimatedLengthMm(edge.from_marker_id, edge.to_marker_id);
  const t = estLen > 0 ? distance_into_edge_mm / estLen : 0;
  return poseAt(path, t * path.length);
}

/**
 * Compute render-time world positions for all live trains and their coupled
 * carriages from the current simulation state.
 *
 * Each live train that has a `current_edge` in the simulation drives:
 *   - its own rendered position (the train sprite follows the sim, not the
 *     placement position),
 *   - each coupled carriage at `CARRIAGE_SPACING_MM * (trailIndex + 1)` behind.
 *
 * If a carriage's computed offset is negative (it would trail onto the
 * previous edge) it is clamped to distance 0 (edge start). Full multi-edge
 * trailing is a TODO for a future revision.
 *
 * Pieces with no resolvable sim edge (train deferred — scanned but no track
 * yet) are omitted; the renderer falls back to `piece.position`.
 *
 * @pure — reads from sim and pieces only; returns a new Map each call.
 */
/**
 * Place one live train (and any coupled carriages) at its simulated edge
 * position, writing into `result`. No-op when the train has no resolvable sim
 * edge (deferred — scanned but no track under it yet).
 */
type ToySimulation = ReturnType<ToyHardware['getSimulation']>;

/**
 * Render a PARKED train (no current sim edge — it ran to a route end and
 * stopped) and its rake from the traversal history, so the whole train stays on
 * the rail behind where it stopped instead of every piece snapping back to its
 * static placement off the track. `offset 0` is the loco at its parked marker;
 * carriages trail back from there. No-op (→ static fallback) when the train has
 * no position at all (deferred — scanned with no track yet).
 */
function placeParkedTrain(
  piece: TrackPiece,
  simTrain: NonNullable<ReturnType<ToySimulation['getTrain']>>,
  piecesById: ReadonlyMap<string, TrackPiece>,
  edgeEstLen: (f: string, to: string) => number,
  carriageIds: ReadonlyArray<string>,
  result: Map<string, WorldPosition>,
): void {
  const cache = new Map<string, EdgePath>();
  const locoPose = trailingCarriagePose(simTrain, 0, piecesById, edgeEstLen, cache);
  if (locoPose === undefined) return;
  result.set(piece.id, locoPose);
  for (let i = 0; i < carriageIds.length; i++) {
    const carriageId = carriageIds[i];
    if (carriageId === undefined) continue;
    const pose = trailingCarriagePose(
      simTrain,
      (i + 1) * CARRIAGE_SPACING_MM,
      piecesById,
      edgeEstLen,
      cache,
    );
    if (pose !== undefined) result.set(carriageId, pose);
  }
}

function placeLiveTrain(
  piece: TrackPiece,
  sim: ToySimulation,
  piecesById: ReadonlyMap<string, TrackPiece>,
  trainTrails: ReadonlyMap<string, ReadonlyArray<string>>,
  result: Map<string, WorldPosition>,
): void {
  const simTrain = sim.getTrain(`T-${piece.id}`);
  if (simTrain === undefined) return;

  const edgeEstLen = (f: string, to: string): number =>
    sim.layout.findEdge(f, to)?.estimated_length_mm ?? 200;
  const carriageIds = trainTrails.get(piece.id) ?? [];

  const endpoints = resolveEdgeEndpoints(simTrain, piecesById);
  if (endpoints === undefined) {
    placeParkedTrain(piece, simTrain, piecesById, edgeEstLen, carriageIds, result);
    return;
  }

  const { fromPiece, toPiece, fromMarkerId, toMarkerId } = endpoints;

  // The TRUE rail the train rides: the composite centre-line path from the
  // current edge's two markers, following the real arc/junction-leg geometry
  // rather than the chord between the two piece centres.
  const path = composeEdgePath(fromPiece, toPiece);

  // Map the sim's logical progress onto the true rail length. The sim measures
  // progress against `estimated_length_mm`; `t` (0..1) is that fraction, and we
  // sample the composite path at `t * L` so the train lands exactly on
  // `toPiece`'s centre at t=1 regardless of how the estimate differs from L.
  const estimatedLengthMm =
    sim.layout.findEdge(fromMarkerId, toMarkerId)?.estimated_length_mm ?? 200;
  const t = estimatedLengthMm > 0 ? simTrain.getDistanceIntoEdge() / estimatedLengthMm : 0;
  const trainDist = t * path.length;

  result.set(piece.id, poseAt(path, trainDist));

  /* Coupled carriages trail behind via the sim's multi-edge traversal history.
     The path cache is seeded with the current edge's already-composed path so
     current-edge carriages are a cache hit; previous-edge carriages compose
     once per distinct edge and then also hit the cache. */
  const pathCache = new Map<string, EdgePath>([[`${fromMarkerId}->${toMarkerId}`, path]]);

  for (let i = 0; i < carriageIds.length; i++) {
    const carriageId = carriageIds[i];
    if (carriageId === undefined) continue;
    const offset = (i + 1) * CARRIAGE_SPACING_MM;
    const pose =
      trailingCarriagePose(simTrain, offset, piecesById, edgeEstLen, pathCache) ??
      poseAt(path, trainDist - offset);
    result.set(carriageId, pose);
  }
}

/** True when at least one live train is currently under power in the sim. */
function anyLiveTrainMoving(
  hardware: ToyHardware,
  pieces: ReadonlyArray<TrackPiece>,
  liveIds: ReadonlySet<string>,
): boolean {
  const sim = hardware.getSimulation();
  for (const p of pieces) {
    if (p.type !== 'train' || !liveIds.has(p.id)) continue;
    const simTrain = sim.getTrain(`T-${p.id}`);
    if (simTrain !== undefined && simTrain.getVelocity() > 0) return true;
  }
  return false;
}

/**
 * The ordered carriage-piece-ids each live train carries. Prefers the
 * SIMULATION consist (seeded from proximity at attach, then mutated by a
 * railyard swap) — that is what makes a shunt visible, the renderer following
 * the sim rather than the static placement. Falls back to live proximity
 * coupling for a train whose consist has not been seeded yet (e.g. the frame a
 * carriage is first dropped, before the hardware effect runs), so hand-built
 * coupling still reads instantly.
 */
function consistTrails(
  pieces: ReadonlyArray<TrackPiece>,
  liveIds: ReadonlySet<string>,
  hardware: ToyHardware,
): Map<string, string[]> {
  const sim = hardware.getSimulation();
  const proximity = computeTrainTrails(pieces, liveIds);
  const trails = new Map<string, string[]>();
  for (const p of pieces) {
    if (p.type !== 'train' || !liveIds.has(p.id)) continue;
    const consist = sim.getTrain(`T-${p.id}`)?.getConsist();
    if (consist !== undefined && consist.length > 0) {
      trails.set(
        p.id,
        consist.map((c) => c.id),
      );
    } else {
      const prox = proximity.get(p.id);
      if (prox !== undefined && prox.length > 0) trails.set(p.id, prox);
    }
  }
  return trails;
}

/** Park a live railyard's resting spare cut as a contiguous rake in whichever
 *  slot the spares currently sit in, so they read as a real cut on a siding (and
 *  a visiting train will reverse onto them). During a maneuver the shunt renders
 *  the cuts itself, so this stands down. */
function placeYardSpares(
  piece: TrackPiece,
  sim: ToySimulation,
  result: Map<string, WorldPosition>,
): void {
  const yard = sim.getRailyard(`YARD-${piece.id}`);
  if (yard === undefined || yard.getInteriorState() != null) return;
  const ids = yard.getSpares().map((c) => c.id);
  if (ids.length === 0) return;
  const sparesSlotY = yard.getSparesSlotY();
  const mirror = yardMirrorCache.get(piece.id) ?? false;
  // entrySlotY is irrelevant to sparesPose; pass the spares slot itself.
  const journey = railyardInteriorJourney(sparesSlotY, sparesSlotY, mirror);
  placeRestingCut(piece, ids, journey.sparesPose, result);
}

function computeRenderPositions(
  pieces: ReadonlyArray<TrackPiece>,
  liveIds: ReadonlySet<string>,
  trainTrails: ReadonlyMap<string, ReadonlyArray<string>>,
  hardware: ToyHardware,
): Map<string, WorldPosition> {
  const result = new Map<string, WorldPosition>();
  const piecesById = new Map<string, TrackPiece>();
  for (const p of pieces) piecesById.set(p.id, p);

  const sim = hardware.getSimulation();
  // Every *live* train rides its simulated edge position — not just trains that
  // happen to have carriages coupled. Without this a lone train renders at its
  // static placement coordinate (e.g. a curve's marker, ~24 mm off the rail),
  // so it looks parked beside the track instead of running on it.
  for (const piece of pieces) {
    if (piece.type === 'train' && liveIds.has(piece.id)) {
      placeLiveTrain(piece, sim, piecesById, trainTrails, result);
    } else if (piece.type === 'railyard' && liveIds.has(piece.id)) {
      placeYardSpares(piece, sim, result);
    }
  }
  // Second pass: a train being shunted INSIDE a yard (ADR-029) overrides its
  // throat position with its interior depth, so it visibly pulls in and out.
  // Runs after the train pass so it wins over `placeLiveTrain`.
  for (const piece of pieces) {
    if (piece.type === 'railyard' && liveIds.has(piece.id)) {
      placeShuntedTrain(piece, sim, result);
    }
  }
  return result;
}

type YardInterior = NonNullable<
  ReturnType<NonNullable<ReturnType<ToySimulation['getRailyard']>>['getInteriorState']>
>;

/** Per-yard "did the train enter from the east throat?" — computed by
 *  placeShuntedTrain (which has the train's throat anchor) each frame and read by
 *  the crane pose (which runs later the same frame), so both agree on the mirror. */
const yardMirrorCache = new Map<string, boolean>();

/** Which centre-line the train rides this phase, how far along (0..1), and
 *  whether it is travelling in reverse (rake trailing AHEAD of the loco). Loco-
 *  referenced: the loco walks each path start→end so its position is continuous
 *  across phases. The two crane phases hold the train at the previous drive's end. */
function shuntSegment(
  interior: YardInterior,
  j: RailyardJourney,
): { local: RailyardJourney['enter']; progress: number; reverse: boolean } {
  switch (interior.phase) {
    case 'lead-out':
      return { local: j.leadOut, progress: interior.progress, reverse: false };
    case 'enter':
      return { local: j.enter, progress: interior.progress, reverse: true };
    case 'decouple':
      return { local: j.enter, progress: 1, reverse: false };
    case 'pull-clear':
      return { local: j.pullClear, progress: interior.progress, reverse: false };
    case 'back-to-spares':
      return { local: j.backToSpares, progress: interior.progress, reverse: true };
    case 'settle':
      return { local: j.settle, progress: interior.progress, reverse: false };
    case 'inspect':
      return { local: j.settle, progress: 1, reverse: false };
    case 'exit-pull':
      return { local: j.exitPull, progress: interior.progress, reverse: false };
    case 'exit-home':
      return { local: j.exitHome, progress: interior.progress, reverse: true };
  }
}

/** True when the train parked at the throat is facing INTO the yard from its EAST
 *  end — so the canonical west-entry journey must be mirrored. Read from the
 *  train's heading vs the yard's local +x (the spine, west→east). */
function yardEntryMirrored(piece: TrackPiece, anchor: WorldPosition | undefined): boolean {
  if (anchor === undefined) return false;
  const into = ((anchor.rotationDeg - piece.rotationDeg) * Math.PI) / 180;
  return Math.cos(into) < 0;
}

/** Transform a yard-local point to world (mirror→rotate→translate, matching the
 *  renderer + worldHalfPath). */
function yardLocalToWorld(piece: TrackPiece, lx: number, ly: number): { x: number; y: number } {
  const rad = (piece.rotationDeg * Math.PI) / 180;
  const fy = (piece.flipped === true ? -1 : 1) * ly;
  return {
    x: piece.position.x + lx * Math.cos(rad) - fy * Math.sin(rad),
    y: piece.position.y + lx * Math.sin(rad) + fy * Math.cos(rad),
  };
}

/** Render a contiguous cut of carriages resting along a slot, from `pose` (the
 *  east end) running back along the slot. */
function placeRestingCut(
  piece: TrackPiece,
  ids: readonly string[],
  pose: { x: number; y: number },
  result: Map<string, WorldPosition>,
): void {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === undefined) continue;
    const w = yardLocalToWorld(piece, pose.x - i * CARRIAGE_SPACING_MM, pose.y);
    result.set(id, { x: w.x, y: w.y, rotationDeg: piece.rotationDeg });
  }
}

/** Render the train the yard is shunting ON THE REAL RAILS: the loco walks the
 *  current phase's centre-line (spine → ladder leg → slot), its coupled rake
 *  trailing along the SAME rail (behind it, or ahead when reversing) — so the
 *  whole train follows the track through the curves rather than floating. The
 *  journey is anchored to the throat the train actually parked at (mirrored if it
 *  entered the east throat) so there's no teleport. The shed rear cut sits parked
 *  in the entry slot; the spare cut waits in the spares slot. No-op when idle. */
function placeShuntedTrain(
  piece: TrackPiece,
  sim: ToySimulation,
  result: Map<string, WorldPosition>,
): void {
  const yard = sim.getRailyard(`YARD-${piece.id}`);
  const interior = yard?.getInteriorState();
  if (interior == null) return;
  const trainPieceId = interior.trainId.startsWith('T-')
    ? interior.trainId.slice(2)
    : interior.trainId;
  const consist = sim.getTrain(interior.trainId)?.getConsist() ?? [];

  const mirror = yardEntryMirrored(piece, result.get(trainPieceId));
  yardMirrorCache.set(piece.id, mirror);
  const journey = railyardInteriorJourney(interior.entrySlotY, interior.sparesSlotY, mirror);
  const seg = shuntSegment(interior, journey);
  const path = worldHalfPath(piece, seg.local);
  const locoArc = seg.progress * path.length;
  const loco = path.at(locoArc);
  const flip = seg.reverse ? 180 : 0;
  // The loco's heading (its sprite faces forward; on a reverse phase that's 180°
  // from the travel tangent). The coupled rake is a RIGID line trailing straight
  // behind the loco along this heading — NOT sampled along the path, which would
  // pile the wagons up where a slot segment runs out and pop them at each phase
  // boundary. A rigid trail stays strung out and continuous.
  const headRad = ((loco.headingDeg + flip) * Math.PI) / 180;
  const back = { x: -Math.cos(headRad), y: -Math.sin(headRad) };
  result.set(trainPieceId, { x: loco.x, y: loco.y, rotationDeg: loco.headingDeg + flip });
  for (let i = 0; i < consist.length; i++) {
    const wagon = consist[i];
    if (wagon === undefined) continue;
    const d = (i + 1) * CARRIAGE_SPACING_MM;
    result.set(wagon.id, {
      x: loco.x + back.x * d,
      y: loco.y + back.y * d,
      rotationDeg: loco.headingDeg + flip,
    });
  }

  // The cuts that aren't on the train: the shed rear cut parked in the entry slot,
  // and the spare cut waiting in the spares slot (until the train couples it).
  placeRestingCut(piece, interior.shedCutIds, journey.shedPose, result);
  placeRestingCut(piece, interior.sparesCutIds, journey.sparesPose, result);
}

/** Angle for a turntable's confirmed switch position; unknown or not-yet-set
 * reads as the resting east alignment (stub-a, 0°). */
function turntableAngleFor(position: string | undefined): number {
  const match = TURNTABLE_POSITIONS.find((p) => p === position);
  return match === undefined ? 0 : TURNTABLE_POSITION_ANGLE_DEG[match];
}

/** True when any live train currently renders within the station's sensor
 * range — "a train is under the sensor, being measured". Visual only; the
 * wire-real measurement is ToyHardware's `reportVisionLengths`. */
function trainUnderSensor(
  station: TrackPiece,
  pieces: ReadonlyArray<TrackPiece>,
  liveIds: ReadonlySet<string>,
  renderPositions: ReadonlyMap<string, WorldPosition>,
): boolean {
  for (const p of pieces) {
    if (p.type !== 'train' || !liveIds.has(p.id)) continue;
    const pos = renderPositions.get(p.id) ?? p.position;
    const d = Math.hypot(pos.x - station.position.x, pos.y - station.position.y);
    if (d <= VISION_SENSOR_RANGE_MM) return true;
  }
  return false;
}

/** The gantry crane is a DECOUPLER. It PARKS at its home end while the self-
 *  propelled train drives itself, and only ever moves to (1) the coupling in the
 *  entry slot, lowering to split it (`decouple`), and (2) over the finished train
 *  to camera-read it (`inspect`). It never lifts, carries, or couples a carriage. */
const CRANE_HOME_X = -RAILYARD_GANTRY_X;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.max(0, Math.min(1, t));

/** The crane's local-frame pose this phase: bridge depth (`x`), head lane (`y`),
 *  whether the hook is lowered (splitting a coupling), and whether it is working
 *  (camera/LED). */
interface YardCraneState {
  readonly x: number;
  readonly y: number;
  readonly hookDown: boolean;
  readonly working: boolean;
}

function yardCraneState(interior: YardInterior, journey: RailyardJourney): YardCraneState {
  switch (interior.phase) {
    case 'decouple': {
      // Run in from home to the COUPLING (between the kept rake and the shed cut)
      // and lower to split it there.
      const t = interior.progress / 0.55;
      return {
        x: lerp(CRANE_HOME_X, journey.couplingPose.x, t),
        y: lerp(0, journey.couplingPose.y, t),
        hookDown: interior.progress > 0.5,
        working: true,
      };
    }
    case 'inspect': {
      // Camera-read the finished train where it rests (no hook).
      const rest = interior.swapping ? journey.settle : journey.enter;
      const at = rest.at(rest.length);
      return { x: at.x, y: at.y, hookDown: false, working: true };
    }
    default:
      // The train drives itself; the crane stays parked at home.
      return { x: CRANE_HOME_X, y: 0, hookDown: false, working: false };
  }
}

/** The crane's pose for the gantry to render (bridge depth + head lane + hook +
 *  LED). Null when the yard isn't shunting, so the crane parks at home. */
interface YardCranePose {
  readonly depthMm: number;
  readonly laneMm: number;
  readonly working: boolean;
  readonly hookDown: boolean;
}

function yardCranePose(piece: TrackPiece, hardware: ToyHardware | null): YardCranePose | null {
  if (hardware === null) return null;
  const interior = hardware.getSimulation().getRailyard(`YARD-${piece.id}`)?.getInteriorState();
  if (interior == null) return null;
  // Same mirror the train used this frame (placeShuntedTrain ran first and cached
  // it) so the crane's work points line up with the train.
  const mirror = yardMirrorCache.get(piece.id) ?? false;
  const journey = railyardInteriorJourney(interior.entrySlotY, interior.sparesSlotY, mirror);
  const s = yardCraneState(interior, journey);
  return { depthMm: s.x, laneMm: s.y, working: s.working, hookDown: s.hookDown };
}

/** Everything `experimentVisualFor` reads — bundled so the per-piece dispatch
 * stays a flat switch. */
interface ExperimentVisualContext {
  readonly pieces: ReadonlyArray<TrackPiece>;
  readonly liveIds: ReadonlySet<string>;
  readonly renderPositions: ReadonlyMap<string, WorldPosition>;
  readonly craneStacks: ReadonlyMap<string, number>;
  readonly sim: ToySimulation | undefined;
}

/** The live visual for ONE piece's moving parts, or undefined for pieces that
 * have none. Sim-owned state (switch position, gate withhold) is read only
 * for LIVE pieces; everything else reads as its resting pose. @pure */
function experimentVisualFor(
  p: TrackPiece,
  ctx: ExperimentVisualContext,
): ExperimentVisual | undefined {
  switch (p.type) {
    case 'turntable': {
      const pos = ctx.liveIds.has(p.id)
        ? ctx.sim?.getSwitch(`SWITCH-${p.id}`)?.getPosition()
        : undefined;
      return { kind: 'turntable', angleDeg: turntableAngleFor(pos) };
    }
    case 'lift-bridge': {
      const raised =
        ctx.liveIds.has(p.id) &&
        ctx.sim?.getGate(`BRIDGE-${p.id}`)?.isWithholding(`M-${p.id}`) === true;
      return { kind: 'lift-bridge', raised };
    }
    case 'vision-station':
      return {
        kind: 'vision-station',
        lit: trainUnderSensor(p, ctx.pieces, ctx.liveIds, ctx.renderPositions),
      };
    case 'crane-station':
      return {
        kind: 'crane-station',
        crates: ctx.craneStacks.get(p.id) ?? CRANE_INITIAL_CRATES,
        // A LIVE crane's arm slides out over the rail whenever any wagon is
        // in reach; an un-scanned crane stays parked over its stack.
        trolleyOverRail:
          ctx.liveIds.has(p.id) &&
          (wagonUnderHook(p, ctx.pieces, true) !== undefined ||
            wagonUnderHook(p, ctx.pieces, false) !== undefined),
      };
    case 'carriage':
      return p.cargo === true ? { kind: 'cargo' } : undefined;
    default:
      return undefined;
  }
}

/**
 * Per-piece live visuals for the experimental pieces' moving parts, read off
 * the SIMULATION (switch position, gate withhold) and the rendered train
 * positions — never duplicated into React state, so the drawn deck angle and
 * span state can't drift from the wire state. Un-scanned pieces read as their
 * resting pose. @pure
 */
function computeExperimentVisuals(
  pieces: ReadonlyArray<TrackPiece>,
  liveIds: ReadonlySet<string>,
  renderPositions: ReadonlyMap<string, WorldPosition>,
  craneStacks: ReadonlyMap<string, number>,
  hardware: ToyHardware | null,
): Map<string, ExperimentVisual> {
  const result = new Map<string, ExperimentVisual>();
  const ctx: ExperimentVisualContext = {
    pieces,
    liveIds,
    renderPositions,
    craneStacks,
    sim: hardware?.getSimulation(),
  };
  for (const p of pieces) {
    const visual = experimentVisualFor(p, ctx);
    if (visual !== undefined) result.set(p.id, visual);
  }
  return result;
}

/** World position of a crane's hook (its gantry centre line), accounting for
 * the piece's rotation. The hook sits on the rail axis, so flip is a no-op. */
function craneHookWorld(crane: TrackPiece): { x: number; y: number } {
  const rad = (crane.rotationDeg * Math.PI) / 180;
  return {
    x: crane.position.x + CRANE_GANTRY_X_MM * Math.cos(rad),
    y: crane.position.y + CRANE_GANTRY_X_MM * Math.sin(rad),
  };
}

/**
 * The wagon under a crane's hook, or undefined — nearest carriage piece within
 * `CRANE_REACH_MM`, laden or empty per `wantLaden`. Reach is judged from the
 * wagon's PLACED position: the crane works standing stock at the yard, not a
 * consist mid-run (the doc's held-state rule — work a pinned train, never a
 * moving one). @pure
 */
function wagonUnderHook(
  crane: TrackPiece,
  pieces: ReadonlyArray<TrackPiece>,
  wantLaden: boolean,
): TrackPiece | undefined {
  const hook = craneHookWorld(crane);
  let best: TrackPiece | undefined;
  let bestD = CRANE_REACH_MM;
  for (const p of pieces) {
    if (p.type !== 'carriage') continue;
    if ((p.cargo === true) !== wantLaden) continue;
    const d = Math.hypot(p.position.x - hook.x, p.position.y - hook.y);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Signature of the sim-owned experimental state (deck positions, span
 * withholds), so the RAF tick can trigger a re-render when a command moves a
 * part while no train is moving — e.g. LearnMode throwing the turntable. */
function experimentSimSignature(
  hardware: ToyHardware,
  pieces: ReadonlyArray<TrackPiece>,
  liveIds: ReadonlySet<string>,
): string {
  const sim = hardware.getSimulation();
  const parts: string[] = [];
  for (const p of pieces) {
    if (!liveIds.has(p.id)) continue;
    if (p.type === 'turntable') {
      parts.push(`${p.id}:${sim.getSwitch(`SWITCH-${p.id}`)?.getPosition() ?? ''}`);
    } else if (p.type === 'lift-bridge') {
      parts.push(`${p.id}:${sim.getGate(`BRIDGE-${p.id}`)?.isWithholding(`M-${p.id}`) === true}`);
    }
  }
  return parts.join('|');
}

/**
 * The height layer a piece should be DRAWN on this frame — which determines its
 * draw order (occlusion) and its drop-shadow group. This is render-only; it
 * never affects the compiled layout or the sampled rail.
 *
 * - Static track / device pieces draw on their own `layerOf`.
 * - A LIVE train draws on `max(layerOf(fromPiece), layerOf(toPiece))` of its
 *   current edge: as soon as it crosses onto the ramp→upper edge mid-ramp it
 *   reads "up" and stays up across the deck, coming back down on the return.
 *   Keying on the train piece's own static layer would draw it UNDER the bridge
 *   it is crossing — the headline failure this guards against.
 * - A carriage draws on its coupled train's effective layer (so a consist rides
 *   the deck together); an uncoupled carriage falls back to its static layer.
 *   A carriage whose coupling drops mid-bridge falls back to its static layer
 *   for a frame — acceptable for the demo.
 *
 * @pure — reads sim + maps only.
 */
/** The minimal structural seam `effectiveLayer` needs from the simulation: look
 * up a train by id and read its current edge. The real `Simulation` satisfies
 * it structurally (so does a plain test stub), so the helper is unit-testable
 * through its real seam without an `any` cast. */
export interface TrainLayerSource {
  getTrain(
    id: string,
  ): { getCurrentEdge(): { from_marker_id: string; to_marker_id: string } | null } | undefined;
}

export function effectiveLayer(
  piece: TrackPiece,
  sim: TrainLayerSource,
  carriageCoupledTo: ReadonlyMap<string, string>,
  piecesById: ReadonlyMap<string, TrackPiece>,
): number {
  if (piece.type === 'train') {
    const simTrain = sim.getTrain(`T-${piece.id}`);
    if (simTrain === undefined) return layerOf(piece);
    const endpoints = resolveEdgeEndpoints(simTrain, piecesById);
    if (endpoints === undefined) return layerOf(piece);
    return Math.max(layerOf(endpoints.fromPiece), layerOf(endpoints.toPiece));
  }
  if (piece.type === 'carriage') {
    const trainPieceId = carriageCoupledTo.get(piece.id);
    if (trainPieceId !== undefined) {
      const trainPiece = piecesById.get(trainPieceId);
      if (trainPiece !== undefined) {
        return effectiveLayer(trainPiece, sim, carriageCoupledTo, piecesById);
      }
    }
    return layerOf(piece);
  }
  return layerOf(piece);
}

/** Build an SVG `filter` string from a layer's height cue, or `undefined` for
 * the ground layer (no shadow). Pure. */
function layerFilter(layer: number): string | undefined {
  const s = layerStyle(layer);
  if (s.dx === 0 && s.dy === 0 && s.blur === 0) return undefined;
  const opacity = s.opacity ?? 0.4;
  return `drop-shadow(${s.dx}px ${s.dy}px ${s.blur}px rgba(0,0,0,${opacity}))`;
}

/** An explicit request to TOGGLE a live wire device's power in place (off↔on).
 * Power OFF makes a train inert-in-place — it stays on the track at its current
 * position and goes silent; it is NOT despawned and emits NO
 * `device_disconnected`. Power ON resumes it. Raised by clicking the device's
 * power dot or the ActionBar power button — NOT by clicking the device body,
 * which only selects it. */
interface PowerToggleAction {
  readonly type: 'power-toggle';
  readonly pieceId: string;
}

/** Hidden devtools handle. Strictly typed so we don't reach for `any`. */
interface TrainframeSimHandle {
  readonly pause: () => void;
  readonly resume: () => void;
  readonly step: (ms: number) => void;
  /** The live in-browser simulation (or null before the table mounts one) — an
   * escape hatch for the live-driving playbook + screenshot harnesses to read
   * device state (e.g. the yard's interior maneuver) from the page. */
  readonly getSimulation: () => ToySimulation | null;
}

declare global {
  interface Window {
    trainframeSim?: TrainframeSimHandle | undefined;
    /** DEV-only seed hook: stages the two-train bridge demo on the table.
     * Registered behind `import.meta.env.DEV`; absent in production builds. */
    __tfLoadBridgeDemo?: (() => void) | undefined;
    /** DEV-only seed hook: stages the multi-train railyard spectacle on the
     * table. Registered behind `import.meta.env.DEV`; absent in production. */
    __tfLoadRailyardDemo?: (() => void) | undefined;
  }
}

/** Viewport state: world-space origin (top-left corner) and zoom level. */
interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Snap target: an existing endpoint that a dragged piece is near enough to snap to. */
interface SnapTarget {
  readonly x: number;
  readonly y: number;
}

/**
 * Convert a client-space pointer position to world-space mm, accounting for
 * the current viewport.  Falls back to the canvas centre when the rect has
 * zero dimensions (jsdom).
 */
function clientToMm(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  viewport: Viewport,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: CANVAS_W_MM / 2, y: CANVAS_H_MM / 2 };
  }
  // The visible world WIDTH is fixed (CANVAS_W_MM at zoom 1); the visible HEIGHT
  // follows the canvas's actual aspect ratio, so the table can fill a box of any
  // shape without distorting the rails. (A 3:2 rect recovers the old 900×600.)
  const worldW = CANVAS_W_MM / viewport.zoom;
  const worldH = worldW * (rect.height / rect.width);
  const xMm = viewport.x + ((clientX - rect.left) / rect.width) * worldW;
  const yMm = viewport.y + ((clientY - rect.top) / rect.height) * worldH;
  return { x: xMm, y: yMm };
}

/** The world-window height (mm) visible at `zoom`, given the canvas box aspect
 * (height/width). Mirrors `clientToMm`'s rule so the viewBox and the pointer
 * mapping always agree. */
function worldHeightMm(zoom: number, aspect: number): number {
  return (CANVAS_W_MM / zoom) * aspect;
}

/** A wheel-zoom step that keeps the world point under the cursor fixed. Pure;
 * returns the new viewport (or `prev` if the rect has no size). Extracted so the
 * wheel listener stays trivial and under the complexity budget. */
function zoomAtCursor(
  prev: Viewport,
  rect: DOMRect,
  clientX: number,
  clientY: number,
  deltaY: number,
): Viewport {
  const worldPos = clientToMm(rect, clientX, clientY, prev);
  const zoomFactor = deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * zoomFactor));
  const worldW = CANVAS_W_MM / newZoom;
  // With a measured rect the world height follows the box aspect; without one
  // (jsdom) fall back to the default aspect and anchor the zoom at the centre.
  const hasRect = rect.width > 0 && rect.height > 0;
  const worldH = hasRect
    ? worldW * (rect.height / rect.width)
    : worldHeightMm(newZoom, CANVAS_H_MM / CANVAS_W_MM);
  const fracX = hasRect ? (clientX - rect.left) / rect.width : 0.5;
  const fracY = hasRect ? (clientY - rect.top) / rect.height : 0.5;
  return { x: worldPos.x - fracX * worldW, y: worldPos.y - fracY * worldH, zoom: newZoom };
}

/**
 * The toy table — v1 of the operator's "Brio table" view of the virtual
 * hardware. Pick a piece from the toybox, click on the table to place it,
 * or drag a toybox entry onto the canvas to drop it at a specific position.
 * Drag a placed piece into the scan box to bind it to the bus.
 *
 * No simulator scheduler runs here. Devices live on the broker only after
 * scanning, and clicking a live train powers it back off (emits
 * `device_disconnected`).
 *
 * Layout is *system-inferred*: the toy-table never publishes a layout state
 * topic. Instead a synthetic GARAGE device announces itself once and then
 * binds tags to markers on each track scan, exactly like real hardware would
 * commission new pieces. Edges are learned by the server from train
 * traversals; the simulator-ui contributes neither markers nor edges to a
 * retained layout document.
 */
interface ToyTableProps {
  /** Initial broker URL, forwarded to the Settings popover. */
  readonly initialUrl: string;
}

export function ToyTable({ initialUrl }: ToyTableProps) {
  const { client } = useBroker();
  const [pieces, setPieces] = useState<ReadonlyArray<TrackPiece>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which piece type the operator has "armed" from the toybox, if any. */
  const [armedType, setArmedType] = useState<TrackPieceType | null>(null);
  /** Livery applied to the next carriage placed (the toybox swatch selection). */
  const [armedCarriageColor, setArmedCarriageColor] = useState<CarriageColorId>('blue');
  /** The deck the operator is currently authoring on (0 = ground). New pieces
   * land on this layer and snapping is gated to it, so an upper-deck loop can be
   * built directly over the ground loop without the two merging. */
  const [activeLayer, setActiveLayer] = useState(0);
  /** Set of piece IDs whose device is currently live on the broker. */
  const [liveIds, setLiveIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Subset of live train piece IDs the operator has powered OFF in place.
   * A powered-off train stays on the track (still in `liveIds`, still spawned
   * and rendered at its frozen sim position) but is inert and silent — it is
   * NOT despawned and emits NO `device_disconnected`. `powered === live && !off`. */
  const [poweredOffIds, setPoweredOffIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Crates each crane holds on its trackside stack (experimental 003).
   * Absent ⇒ the fresh-crane default. Grows on a lift, shrinks on a place —
   * the crates themselves are cosmetic, never on the wire. */
  const [craneStacks, setCraneStacks] = useState<ReadonlyMap<string, number>>(() => new Map());
  /** Pieces the operator has placed into the scan box. Keyed by piece id. */
  const piecesRef = useRef(pieces);
  piecesRef.current = pieces;
  /** Ref kept in sync with `liveIds` so the pagehide handler can read the
   * latest set without capturing a stale closure. */
  const liveIdsRef = useRef(liveIds);
  liveIdsRef.current = liveIds;

  /** Whether the synthetic GARAGE has announced itself on the bus this
   * session. A ref (not state) so two scans in the same render cycle still
   * see the same value without stale-closure pitfalls. Resets per mount, so
   * it's component-scoped rather than a module-level singleton. */
  const garageRegisteredRef = useRef(false);

  /** ScanBox hands us a function to begin a scan; the canvas calls it when a
   * piece is pointer-dragged onto the scan box (placed pieces are SVG and can't
   * start native DnD, so the HTML5 drop path never fires for them). */
  const scanTriggerRef = useRef<((pieceId: string) => void) | null>(null);
  const handleScanBoxReady = useCallback((beginScan: (pieceId: string) => void) => {
    scanTriggerRef.current = beginScan;
  }, []);
  const requestScan = useCallback((pieceId: string) => {
    scanTriggerRef.current?.(pieceId);
  }, []);

  // Tick counter — bumped after each RAF frame when at least one coupled train
  // is moving, so React re-renders with fresh sim positions. We keep the bump
  // cheap: only increment when `trainTrails` is non-empty (carriage coupling
  // exists) so idle/empty tables don't churn.
  const [_tickCount, setTickCount] = useState(0);
  const trainTrailsRef = useRef<ReadonlyMap<string, string[]>>(new Map());
  /** Last seen sim-owned experimental state (deck angles, span withholds), so
   * the tick loop re-renders when a part moves while no train is. */
  const experimentSigRef = useRef('');

  // Stand up an in-browser physics simulation wired to the broker. It hosts
  // the virtual trains and gates the operator scans onto the bus, and reacts
  // to clearance commands the real server publishes. Layout is *private* to
  // the sim — never published, only used so the trains know where the rails
  // are; the server still infers the public layout from `tag_assignment`
  // events ToyTable emits on scan.
  const { hardwareRef } = useToyHardware({
    pieces,
    liveIds,
    poweredOffIds,
    client,
    onTick: () => {
      // Re-render with fresh sim positions while something is actually moving:
      // a live train under power, or any coupled-carriage trail. Idle tables
      // (nothing scanned, or a parked train) don't churn.
      const hw = hardwareRef.current;
      if (hw !== null) {
        // The experimental moving parts (turntable deck, bridge span) follow
        // SIM state, not React state — re-render when a command moved one even
        // though no train is rolling (e.g. LearnMode throwing the deck).
        const sig = experimentSimSignature(hw, piecesRef.current, liveIdsRef.current);
        if (sig !== experimentSigRef.current) {
          experimentSigRef.current = sig;
          setTickCount((n) => n + 1);
          return;
        }
      }
      const moving = hw !== null && anyLiveTrainMoving(hw, piecesRef.current, liveIdsRef.current);
      if (moving || trainTrailsRef.current.size > 0) {
        setTickCount((n) => n + 1);
      }
    },
  });

  // Devtools handle — a tiny escape hatch for poking the page from the console.
  // The toy-table v1 has no internal tick loop (devices come and go only via
  // operator actions), so `pause/resume/step` are no-ops in this build but
  // present so the API stays stable.
  useEffect(() => {
    const handle: TrainframeSimHandle = {
      pause: () => {},
      resume: () => {},
      step: () => {},
      getSimulation: () => hardwareRef.current?.getSimulation() ?? null,
    };
    window.trainframeSim = handle;
    return () => {
      // exactOptionalPropertyTypes forbids `delete`; assign undefined.
      window.trainframeSim = undefined;
    };
  }, [hardwareRef]);

  // DEV-only: a console/orchestrator hook that stages the unified flyover demo
  // — one connected theta-graph track with a diverge junction (J1), a layer-1
  // deck bridging over a ground main-loop edge, and a passive merge (J2) — and
  // marks every piece (track + both trains) live so the sim binds identity tags
  // and the length-aware trains spawn. The orchestrator (scripts/bridge-demo-
  // server.mjs) then runs a real server that assigns each train a schedule, and
  // the scheduler throws J1 to 'divert' for train A (over the bridge) and 'main'
  // for train B. Behind `import.meta.env.DEV` so it never ships; cleared on unmount.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__tfLoadBridgeDemo = () => {
      const demo = buildBridgeDemo();
      setPieces(demo.pieces);
      setLiveIds(new Set(demo.liveIds));
      // Commission every piece on the bus exactly as the scan-box would, so an
      // external server's tag registry resolves marker observations. The seed
      // path otherwise only binds tags inside the in-browser sim (silent on the
      // wire), leaving the server unable to resolve `tag_observed` events.
      let garage = garageRegisteredRef.current;
      for (const piece of demo.pieces) {
        if (scanPiece(client, piece, garage)) garage = true;
      }
      garageRegisteredRef.current = garage;
    };
    return () => {
      window.__tfLoadBridgeDemo = undefined;
    };
  }, [client]);

  // DEV-only: stage the multi-train railyard spectacle — a main loop with the
  // yard hung off it as a junction branch, trains each with a coloured rake, and
  // purple spares in the yard. Marks every piece live and scans it onto the bus
  // (like the scan-box) so an external server resolves the trains' marker
  // observations and can schedule them. The orchestrator
  // (scripts/railyard-demo-server) then assigns each train a cyclic schedule.
  //
  // Consists are seeded EXPLICITLY via the sim API once the trains spawn, NOT by
  // proximity: the four stations sit close enough that ToyHardware's proximity
  // reseed would merge adjacent trains' rakes into one. We let that reseed run
  // (it fires once at stage time on the static positions) and then overwrite it
  // with each train's exact rake by id — so what migrates is never guessed.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__tfLoadRailyardDemo = () => {
      const demo = buildRailyardDemo();
      setPieces(demo.pieces);
      setLiveIds(new Set(demo.liveIds));
      let garage = garageRegisteredRef.current;
      for (const piece of demo.pieces) {
        if (scanPiece(client, piece, garage)) garage = true;
      }
      garageRegisteredRef.current = garage;

      // Poll until every train + the yard have spawned, then seed consists +
      // spares by id (overriding the proximity reseed). Bounded so a failed
      // stage doesn't poll forever.
      const seedConsists = (attempt: number): void => {
        const sim = hardwareRef.current?.getSimulation();
        const ready =
          sim !== undefined &&
          demo.trains.every((t) => sim.getTrain(t.deviceId) !== undefined) &&
          sim.getRailyard(demo.yardDeviceId) !== undefined;
        if (!ready) {
          if (attempt < 50) setTimeout(() => seedConsists(attempt + 1), 100);
          return;
        }
        for (const t of demo.trains) {
          sim.setTrainConsist(
            t.deviceId,
            t.consist.map((c) => ({ id: c.id, colorId: c.colorId as CarriageColorId })),
          );
        }
        sim
          .getRailyard(demo.yardDeviceId)
          ?.loadSpares(
            demo.yardSpares.map((c) => ({ id: c.id, colorId: c.colorId as CarriageColorId })),
          );
      };
      seedConsists(0);
    };
    return () => {
      window.__tfLoadRailyardDemo = undefined;
    };
  }, [client, hardwareRef]);

  // pagehide: publish `device_disconnected` for every wire-visible live
  // device before the WebSocket tears down. Playwright's `page.close()`
  // and real browser tab-close both fire `pagehide` synchronously before
  // the page is destroyed, so the publish goes out while the socket is
  // still open. Without this, closing the tab leaves trains visible in the
  // visualiser indefinitely because no disconnect events are published.
  useEffect(() => {
    function handlePageHide() {
      const currentPieces = piecesRef.current;
      const currentLiveIds = liveIdsRef.current;
      for (const pieceId of currentLiveIds) {
        const piece = currentPieces.find((p) => p.id === pieceId);
        if (piece === undefined) continue;
        if (!isWireDevice(piece.type)) continue;
        const device_id = deviceIdForDevicePiece(piece);
        const { topic, payload } = encodeDeviceEvent('device_disconnected', device_id, {});
        client.publish(topic, payload);
      }
    }
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [client]);

  const armPieceType = useCallback((type: TrackPieceType) => {
    setArmedType((prev) => (prev === type ? null : type));
  }, []);

  const placePiece = useCallback(
    (xMm: number, yMm: number, type?: TrackPieceType, rotation?: RotationDeg) => {
      const pieceType = type ?? armedType;
      if (pieceType === null) {
        setSelectedId(null);
        return;
      }
      // A train snapped onto a marker faces the way it will travel at power-on
      // (no heading pop); other pieces keep their placement rotation. Computed
      // from the current pieces (the snap/orient is over track already placed).
      const orient =
        pieceType === 'train'
          ? spawnOrientationDeg({ x: xMm, y: yMm }, piecesRef.current)
          : undefined;
      const piece: TrackPiece = {
        id: nextPieceId(pieceType),
        type: pieceType,
        position: { x: xMm, y: yMm },
        rotationDeg: orient ?? rotation ?? 0,
        tagged: false,
        // Only stamp a layer when authoring above ground. exactOptionalPropertyTypes
        // forbids writing `layer: undefined`, and absent ⇒ ground anyway.
        ...(activeLayer !== 0 ? { layer: activeLayer } : {}),
        // A carriage carries the armed livery so it stays trackable through a
        // shunt. Other pieces never get a colorId.
        ...(pieceType === 'carriage' ? { colorId: armedCarriageColor } : {}),
      };
      setPieces((prev) => [...prev, piece]);
      setSelectedId(piece.id);
      // Stay armed so the operator can drop multiple of the same type without
      // re-clicking the toybox.
    },
    [armedType, activeLayer, armedCarriageColor],
  );

  // Reposition an already-placed piece (dragged across the canvas). Snaps +
  // orients onto a neighbour's open end when one is in reach; otherwise drops
  // it where released, keeping its current rotation so a free move doesn't
  // surprise-rotate it back to 0°.
  const movePiece = useCallback((pieceId: string, xMm: number, yMm: number) => {
    setPieces((prev) => {
      const moving = prev.find((p) => p.id === pieceId);
      if (moving === undefined) return prev;
      const others = prev.filter((p) => p.id !== pieceId);
      const placement = computeMovePlacement(moving, xMm, yMm, others);
      // A moved train re-orients to its (new) spawn edge so it stays pop-free.
      const orient =
        moving.type === 'train'
          ? spawnOrientationDeg({ x: placement.x, y: placement.y }, others)
          : undefined;
      return prev.map((p) =>
        p.id === pieceId
          ? {
              ...p,
              position: { x: placement.x, y: placement.y },
              rotationDeg: orient ?? placement.rotationDeg,
            }
          : p,
      );
    });
    setSelectedId(pieceId);
  }, []);

  const rotateSelected = useCallback(() => {
    if (selectedId === null) return;
    setPieces((prev) =>
      prev.map((p) =>
        p.id === selectedId ? { ...p, rotationDeg: nextRotation(p.rotationDeg) } : p,
      ),
    );
  }, [selectedId]);

  // Flip (mirror) the selected piece — a right-hand curve becomes left-hand. If
  // the piece is connected to a neighbour, re-snap it onto that joint so it
  // stays joined, just bending the other way; a free piece mirrors in place.
  const flipSelected = useCallback(() => {
    if (selectedId === null) return;
    setPieces((prev) => {
      const target = prev.find((p) => p.id === selectedId);
      if (target === undefined) return prev;
      // A ramp has no left/right-hand variant — it's symmetric across its length,
      // so a mirror-flip would change nothing. Its only meaningful "mirror" is
      // reversing the incline, which for this centred, collinear piece is a 180°
      // rotation in place: the two endpoints swap world positions (so a connected
      // ramp stays joined) and the higher end — and the uphill chevrons — point
      // the other way. So Flip on a ramp reverses its slope.
      if (target.type === 'ramp') {
        return prev.map((p) =>
          p.id === selectedId
            ? { ...p, rotationDeg: ((p.rotationDeg + 180) % 360) as RotationDeg }
            : p,
        );
      }
      const flipped = !(target.flipped === true);
      const others = prev.filter((p) => p.id !== selectedId);
      const entry = getEndpoints(target)[0];
      const placement =
        entry !== undefined
          ? computePlacement(entry.x, entry.y, target.type, others, flipped, layerOf(target))
          : undefined;
      return prev.map((p) => {
        if (p.id !== selectedId) return p;
        if (placement?.connected === true) {
          return {
            ...p,
            flipped,
            position: { x: placement.x, y: placement.y },
            rotationDeg: placement.rotationDeg,
          };
        }
        return { ...p, flipped };
      });
    });
  }, [selectedId]);

  const deleteSelected = useCallback(() => {
    if (selectedId === null) return;
    setPieces((prev) => prev.filter((p) => p.id !== selectedId));
    setLiveIds((prev) => {
      if (!prev.has(selectedId)) return prev;
      const next = new Set(prev);
      next.delete(selectedId);
      return next;
    });
    // Delete is a genuine despawn: drop any power-off bookkeeping too so a
    // re-placed piece with a recycled id never resurrects as inert.
    setPoweredOffIds((prev) => {
      if (!prev.has(selectedId)) return prev;
      const next = new Set(prev);
      next.delete(selectedId);
      return next;
    });
    setSelectedId(null);
  }, [selectedId]);

  // Keyboard: R rotates, F flips, Delete/Backspace deletes, Escape clears.
  useEffect(() => {
    const handlers: Record<string, () => void> = {
      r: rotateSelected,
      R: rotateSelected,
      f: flipSelected,
      F: flipSelected,
      Delete: deleteSelected,
      Backspace: deleteSelected,
      Escape: () => setSelectedId(null),
    };
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (selectedId === null) return;
      const handler = handlers[e.key];
      if (handler === undefined) return;
      if (e.key !== 'Escape') e.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, rotateSelected, flipSelected, deleteSelected]);

  // Describe a piece for the ScanBox's confirmation panel. Called on drop;
  // no broker events are fired here — only on Bind.
  const describePiece = useCallback(
    (pieceId: string): { typeLabel: string; bindingId: string } | undefined => {
      const piece = piecesRef.current.find((p) => p.id === pieceId);
      if (piece === undefined) return undefined;
      const typeLabel = PIECE_LABELS[piece.type];
      const bindingId = isWireDevice(piece.type) ? deviceIdForDevicePiece(piece) : `M-${piece.id}`;
      return { typeLabel, bindingId };
    },
    [],
  );

  // Confirm handler — fired only when the operator clicks Bind in the ScanBox.
  const handleScanConfirm = useCallback(
    (pieceId: string) => {
      const piece = piecesRef.current.find((p) => p.id === pieceId);
      if (piece === undefined) return;
      const announcedGarage = scanPiece(client, piece, garageRegisteredRef.current);
      if (announcedGarage) garageRegisteredRef.current = true;
      setLiveIds((prev) => {
        const next = new Set(prev);
        next.add(piece.id);
        return next;
      });
    },
    [client],
  );

  // Toggle a live train's power IN PLACE (off↔on). Power OFF makes it inert at
  // its current position and silent on the bus — it stays in `liveIds` (so it
  // keeps rendering at its frozen sim position) and emits NO
  // `device_disconnected`. The server, hearing silence (not a disconnect),
  // keeps the train's last state and holds its block reserved. Power ON resumes
  // driving. Only train pieces are powered (gates have no motion); a gate or
  // carriage toggle is a no-op. This is the SOLE power path: reached by an
  // EXPLICIT affordance (the device's power dot, or the ActionBar power
  // button), never by clicking the device body — that merely selects.
  const togglePower = useCallback((pieceId: string) => {
    const piece = piecesRef.current.find((p) => p.id === pieceId);
    if (piece === undefined || piece.type !== 'train') return;
    if (!liveIdsRef.current.has(piece.id)) return; // not on the bus — nothing to power
    setPoweredOffIds((prev) => {
      const next = new Set(prev);
      if (next.has(piece.id)) next.delete(piece.id);
      else next.add(piece.id);
      return next;
    });
  }, []);

  // Raise / lower a live lift bridge's span (experimental 005). The span's
  // gate withholds clearance across the bridge's own marker the INSTANT a
  // raise is requested, and grants again on lowering — `core.gates_clearance`
  // carrying "the track is physically not there right now". The design doc's
  // confirmed-clear-before-raising check is its open question; the toy span
  // raises regardless, and the clearance model keeps approaching trains out.
  const toggleBridgeSpan = useCallback(
    (pieceId: string) => {
      const piece = piecesRef.current.find((p) => p.id === pieceId);
      if (piece === undefined || piece.type !== 'lift-bridge') return;
      if (!liveIdsRef.current.has(pieceId)) return;
      const gate = hardwareRef.current?.getSimulation().getGate(`BRIDGE-${pieceId}`);
      if (gate === undefined) return;
      const markerId = `M-${pieceId}`;
      if (gate.isWithholding(markerId)) gate.release(markerId);
      else gate.withhold(markerId, 'span raised');
      // Visuals follow the sim; nudge a re-render so the tilt starts now.
      setTickCount((n) => n + 1);
    },
    [hardwareRef],
  );

  // Spin a live turntable's deck to its next stub — the toy-table equivalent
  // of a child turning the deck by hand. The device seats and CONFIRMS the new
  // position on the bus (`switch_state_changed`, confirmed: true) exactly as
  // it would answering a `set_switch_position` command.
  const spinTurntable = useCallback(
    (pieceId: string) => {
      if (!liveIdsRef.current.has(pieceId)) return;
      const sw = hardwareRef.current?.getSimulation().getSwitch(`SWITCH-${pieceId}`);
      if (sw === undefined) return;
      // An unset deck rests at stub-a's angle, so the first spin moves on to
      // stub-b — findIndex's -1 and stub-a both advance from index 0.
      const idx = Math.max(
        TURNTABLE_POSITIONS.findIndex((p) => p === sw.getPosition()),
        0,
      );
      const next = TURNTABLE_POSITIONS[(idx + 1) % TURNTABLE_POSITIONS.length];
      if (next !== undefined) sw.setPosition(next);
      setTickCount((n) => n + 1);
    },
    [hardwareRef],
  );

  // Work a crate between a live crane's trackside stack and the wagon under
  // its hook (experimental 003). The transfer is bracketed by a clearance
  // withhold/grant on the crane's own marker — the honest "don't leave yet"
  // pin the doc requires (never a dwell timer) — and NOTHING cargo-specific
  // touches the wire: the crate is a piece-state fact, exactly as carriages
  // are to trains (ADR-016).
  const transferCrate = useCallback(
    (craneId: string, lifting: boolean) => {
      const crane = piecesRef.current.find((p) => p.id === craneId);
      if (crane === undefined || crane.type !== 'crane-station') return;
      if (!liveIdsRef.current.has(craneId)) return;
      const stack = craneStacks.get(craneId) ?? CRANE_INITIAL_CRATES;
      if (lifting ? stack >= CRANE_STACK_SLOTS.length : stack <= 0) return;
      const wagon = wagonUnderHook(crane, piecesRef.current, lifting);
      if (wagon === undefined) return;

      const gate = hardwareRef.current?.getSimulation().getGate(`CRANE-${craneId}`);
      const markerId = `M-${craneId}`;
      gate?.withhold(markerId, lifting ? 'crane lift' : 'crane place');
      setPieces((prev) => prev.map((p) => (p.id === wagon.id ? { ...p, cargo: !lifting } : p)));
      setCraneStacks((prev) => {
        const next = new Map(prev);
        next.set(craneId, stack + (lifting ? 1 : -1));
        return next;
      });
      gate?.release(markerId);
    },
    [craneStacks, hardwareRef],
  );

  // Route a piece's pointer action: a body click selects; the power dot raises
  // an explicit `power-toggle`. Selecting a live train does NOT power it off and
  // does NOT teleport it — it keeps rendering at its simulated edge position.
  const handlePiecePointerAction = useCallback(
    (pieceId: string, action: 'select' | PowerToggleAction) => {
      if (action === 'select') {
        setSelectedId(pieceId);
        return;
      }
      togglePower(pieceId);
    },
    [togglePower],
  );

  const selectedPiece = pieces.find((p) => p.id === selectedId) ?? null;

  // Coupling: read which carriages each live train carries, in order, from the
  // SIMULATION consist (seeded from proximity at attach, then authoritative — a
  // railyard rearranges it, so this reflects swaps). Falls back to an empty map
  // when no hardware yet.
  const hardware = hardwareRef.current;
  const trainTrails: ReadonlyMap<string, string[]> =
    hardware !== null ? consistTrails(pieces, liveIds, hardware) : new Map<string, string[]>();
  trainTrailsRef.current = trainTrails;

  // Compute render positions from the live simulation. Only non-empty when
  // there are coupled carriages and the train has a resolved sim edge.
  const hasLiveTrain = pieces.some((p) => p.type === 'train' && liveIds.has(p.id));
  const renderPositions =
    hardware !== null && hasLiveTrain
      ? computeRenderPositions(pieces, liveIds, trainTrails, hardware)
      : new Map<string, WorldPosition>();

  // Live state for the experimental pieces' moving parts, read off the sim.
  const experimentVisuals = computeExperimentVisuals(
    pieces,
    liveIds,
    renderPositions,
    craneStacks,
    hardware,
  );
  const selectedVisual =
    selectedPiece !== null ? experimentVisuals.get(selectedPiece.id) : undefined;

  // Crane affordance enablement: a wagon of the right state under the hook,
  // and room/stock on the stack.
  const selectedCrane =
    selectedPiece !== null && selectedPiece.type === 'crane-station' ? selectedPiece : null;
  const selectedCraneStack =
    selectedCrane !== null
      ? (craneStacks.get(selectedCrane.id) ?? CRANE_INITIAL_CRATES)
      : CRANE_INITIAL_CRATES;
  const craneCanLift =
    selectedCrane !== null &&
    selectedCraneStack < CRANE_STACK_SLOTS.length &&
    wagonUnderHook(selectedCrane, pieces, true) !== undefined;
  const craneCanPlace =
    selectedCrane !== null &&
    selectedCraneStack > 0 &&
    wagonUnderHook(selectedCrane, pieces, false) !== undefined;

  return (
    <div className="tf-toytable-page">
      {/* Wood gradients live once here so both the canvas and the parts-tray
          previews can reference them by id (SVG ids are document-scoped). */}
      <svg className="tf-toytable__defs" width="0" height="0" aria-hidden="true">
        <WoodDefs />
      </svg>
      {/* The white "table" card: header, controls, and the table surface. */}
      <div className="tf-toytable">
        <header className="tf-toytable__header">
          <h1>Trainframe Toy Table</h1>
          <ConnectionStatus />
          <Settings initialUrl={initialUrl} />
        </header>
        <ActionBar
          selectedPiece={selectedPiece}
          selectedLive={selectedPiece !== null && liveIds.has(selectedPiece.id)}
          selectedPoweredOff={selectedPiece !== null && poweredOffIds.has(selectedPiece.id)}
          onRotate={rotateSelected}
          onFlip={flipSelected}
          onDelete={deleteSelected}
          onTogglePower={() => {
            if (selectedPiece !== null) togglePower(selectedPiece.id);
          }}
          selectedBridgeRaised={selectedVisual?.kind === 'lift-bridge' && selectedVisual.raised}
          onToggleBridgeSpan={() => {
            if (selectedPiece !== null) toggleBridgeSpan(selectedPiece.id);
          }}
          onSpinDeck={() => {
            if (selectedPiece !== null) spinTurntable(selectedPiece.id);
          }}
          craneCanLift={craneCanLift}
          craneCanPlace={craneCanPlace}
          onLiftCrate={() => {
            if (selectedPiece !== null) transferCrate(selectedPiece.id, true);
          }}
          onPlaceCrate={() => {
            if (selectedPiece !== null) transferCrate(selectedPiece.id, false);
          }}
          armedType={armedType}
          activeLayer={activeLayer}
          maxLevel={pieces.reduce((m, p) => Math.max(m, layerOf(p)), activeLayer)}
          onActiveLayerChange={setActiveLayer}
        />
        {/* The table itself, with the scan zone floating in its bottom-left
          corner — drag a placed piece onto it to put it on the bus. */}
        <div className="tf-toytable__stage">
          <Table
            pieces={pieces}
            liveIds={liveIds}
            poweredOffIds={poweredOffIds}
            selectedId={selectedId}
            armedType={armedType}
            activeLayer={activeLayer}
            trainTrails={trainTrails}
            renderPositions={renderPositions}
            experimentVisuals={experimentVisuals}
            hardware={hardware}
            onCanvasClick={placePiece}
            onMovePiece={movePiece}
            onScanPiece={requestScan}
            onPieceAction={handlePiecePointerAction}
          />
          <div className="tf-toytable__scanzone">
            <ScanBox
              describePiece={describePiece}
              onConfirm={handleScanConfirm}
              onReady={handleScanBoxReady}
            />
          </div>
        </div>
      </div>
      {/* The parts shelf sits OFF the table — on the desk below the white card.
          Drag a wooden part up onto the table to place it. */}
      <Toybox
        armedType={armedType}
        onArm={armPieceType}
        carriageColor={armedCarriageColor}
        onPickCarriageColor={setArmedCarriageColor}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toybox
// ---------------------------------------------------------------------------

interface ToyboxProps {
  readonly armedType: TrackPieceType | null;
  readonly onArm: (type: TrackPieceType) => void;
  readonly carriageColor: CarriageColorId;
  readonly onPickCarriageColor: (color: CarriageColorId) => void;
}

function Toybox({ armedType, onArm, carriageColor, onPickCarriageColor }: ToyboxProps) {
  // Tray groups come straight from the registry (TOYBOX_TRAYS): the Track and
  // Devices staples, then the "Experiments" box — the shared home for the
  // docs/experimental viability-test pieces, kept apart so an operator
  // reaching for one knows they are picking up a stress-test.
  return (
    <div className="tf-toybox" aria-label="Parts tray">
      {TOYBOX_TRAYS.map((tray) => (
        <ToyboxGroup
          key={tray.heading}
          heading={tray.heading}
          types={tray.types}
          armedType={armedType}
          onArm={onArm}
        />
      ))}
      {armedType === 'carriage' && (
        <CarriageLiveryPicker selected={carriageColor} onPick={onPickCarriageColor} />
      )}
    </div>
  );
}

interface CarriageLiveryPickerProps {
  readonly selected: CarriageColorId;
  readonly onPick: (color: CarriageColorId) => void;
}

/**
 * Swatch row shown when the carriage tool is armed: pick the livery the next
 * carriage carries. The colour is intrinsic to the placed wagon, so the
 * operator can build a same-coloured rake per train (and a wagon stays
 * recognisable when a railyard shunts it onto a different train).
 */
function CarriageLiveryPicker({ selected, onPick }: CarriageLiveryPickerProps) {
  return (
    <section className="tf-toybox__group" aria-label="Carriage livery">
      <h2 className="tf-toybox__heading">Livery</h2>
      <ul className="tf-toybox__swatches">
        {CARRIAGE_COLOR_IDS.map((color) => (
          <li key={color}>
            <button
              type="button"
              className="tf-toybox__swatch"
              data-testid={`toybox-carriage-color-${color}`}
              aria-label={color}
              aria-pressed={selected === color}
              style={{ background: CARRIAGE_COLORS[color] }}
              onClick={() => onPick(color)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A small wooden render of a piece type — the actual shape the operator drags
 * onto the table, drawn with the same body/groove/feature spec as the live
 * pieces (referencing the shared wood gradients in the page `<defs>`).
 */
function PiecePreview({ type }: { type: TrackPieceType }) {
  const shape = getPieceShape({
    id: type,
    type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
  });
  const isDevice = isDevicePiece(type);
  // An experimental piece's moving parts (deck, span) are not in the static
  // body — preview them at their resting pose so the tray shows the whole toy.
  const restingVisual = restingExperimentVisual(type);
  const pad = 14;
  const w = shape.width + pad * 2;
  const h = shape.height + pad * 2;
  return (
    <svg
      className="tf-toybox__preview"
      viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <PieceBody
        shape={shape}
        bodyFill={isDevicePiece(type) ? DEVICE_FILL[type] : WOOD_FILL}
        tint={PIECE_TINT[type]}
        isDevice={isDevice}
        dim={1}
      />
      <ExperimentParts pieceId={`preview-${type}`} visual={restingVisual} />
    </svg>
  );
}

interface ToyboxGroupProps {
  readonly heading: string;
  readonly types: ReadonlyArray<TrackPieceType>;
  readonly armedType: TrackPieceType | null;
  readonly onArm: (type: TrackPieceType) => void;
}

function ToyboxGroup({ heading, types, armedType, onArm }: ToyboxGroupProps) {
  return (
    <section className="tf-toybox__group" aria-label={heading}>
      <h2 className="tf-toybox__heading">{heading}</h2>
      <ul className="tf-toybox__list">
        {types.map((type) => {
          const armed = armedType === type;
          return (
            <li key={type}>
              <ToyboxButton type={type} armed={armed} onArm={onArm} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface ToyboxButtonProps {
  readonly type: TrackPieceType;
  readonly armed: boolean;
  readonly onArm: (type: TrackPieceType) => void;
}

function ToyboxButton({ type, armed, onArm }: ToyboxButtonProps) {
  function handleDragStart(e: React.DragEvent<HTMLButtonElement>) {
    e.dataTransfer.setData(TOYBOX_DRAG_MIME, type);
    e.dataTransfer.effectAllowed = 'copy';
  }

  return (
    <button
      type="button"
      className={`tf-toybox__button${armed ? ' tf-toybox__button--armed' : ''}`}
      onClick={() => onArm(type)}
      onDragStart={handleDragStart}
      draggable
      aria-pressed={armed}
      title={`${PIECE_LABELS[type]} — drag onto the table`}
      data-testid={`toybox-${type}`}
    >
      <PiecePreview type={type} />
      <span className="tf-toybox__label">{PIECE_LABELS[type]}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Action bar
// ---------------------------------------------------------------------------

interface ActionBarProps {
  readonly selectedPiece: TrackPiece | null;
  /** Whether the selected piece is currently live on the bus (scanned). */
  readonly selectedLive: boolean;
  /** Whether the selected (live) train is powered OFF in place. */
  readonly selectedPoweredOff: boolean;
  readonly onRotate: () => void;
  readonly onFlip: () => void;
  readonly onDelete: () => void;
  /** Toggle the selected train's power in place (off↔on). Shown only for a
   * live train; never despawns or disconnects it. */
  readonly onTogglePower: () => void;
  /** Whether the selected (live) lift bridge's span is currently raised. */
  readonly selectedBridgeRaised: boolean;
  /** Raise/lower the selected live lift bridge's span (experimental 005). */
  readonly onToggleBridgeSpan: () => void;
  /** Spin the selected live turntable's deck to its next stub (experimental 002). */
  readonly onSpinDeck: () => void;
  /** A laden wagon sits under the selected crane's hook and the stack has room. */
  readonly craneCanLift: boolean;
  /** An empty wagon sits under the hook and the stack has a crate to give. */
  readonly craneCanPlace: boolean;
  /** Lift a crate off the wagon under the hook onto the stack (experimental 003). */
  readonly onLiftCrate: () => void;
  /** Place a crate from the stack onto the wagon under the hook. */
  readonly onPlaceCrate: () => void;
  readonly armedType: TrackPieceType | null;
  /** The deck new pieces land on (0 = ground). */
  readonly activeLayer: number;
  /** Highest deck the selector shows — the deeper of the highest deck any piece
   * sits on and the active deck (so a freshly-added, still-empty top deck stays
   * visible). The "+ Add level" button offers `maxLevel + 1`. */
  readonly maxLevel: number;
  readonly onActiveLayerChange: (layer: number) => void;
}

/** Human label for a deck: ground floor, then numbered levels up. */
function layerLabel(layer: number): string {
  return layer === 0 ? 'Ground' : `Level ${layer}`;
}

/** The action-bar status line — guides the operator on what to do next. */
function actionBarStatus(
  selectedPiece: TrackPiece | null,
  selectedLive: boolean,
  selectedPoweredOff: boolean,
  armedType: TrackPieceType | null,
): string {
  if (armedType !== null) {
    return `Armed: ${PIECE_LABELS[armedType]} — click or drag to place`;
  }
  if (selectedPiece === null) {
    return 'Pick a piece from the toybox';
  }
  const flip = selectedPiece.flipped === true ? ' · flipped' : '';
  const base = `Selected: ${PIECE_LABELS[selectedPiece.type]} · ${selectedPiece.rotationDeg}°${flip}`;
  // A wire device (train / gate) does nothing until it's scanned onto the bus.
  if (isWireDevice(selectedPiece.type) && !selectedLive) {
    return `${base} — drag it onto the scan box to put it on the bus`;
  }
  if (selectedPiece.type === 'train' && selectedLive) {
    if (selectedPoweredOff) {
      return `${base} · powered off — inert on the track (block held); Power on to resume`;
    }
    return `${base} · on the bus — drive it from the visualiser (Learn track or a schedule)`;
  }
  return base;
}

/**
 * The physical affordances on the live experimental devices: raising a bridge
 * span, spinning a turntable deck, working a crate with the crane. Each is the
 * operator acting ON the device (a hand on the toy), not driving the system —
 * driving stays in the visualiser. Extracted from ActionBar so it stays under
 * the complexity budget as the Experiments box grows.
 */
function ExperimentActions({
  selectedPiece,
  selectedLive,
  selectedBridgeRaised,
  onToggleBridgeSpan,
  onSpinDeck,
  craneCanLift,
  craneCanPlace,
  onLiftCrate,
  onPlaceCrate,
}: Pick<
  ActionBarProps,
  | 'selectedPiece'
  | 'selectedLive'
  | 'selectedBridgeRaised'
  | 'onToggleBridgeSpan'
  | 'onSpinDeck'
  | 'craneCanLift'
  | 'craneCanPlace'
  | 'onLiftCrate'
  | 'onPlaceCrate'
>) {
  if (selectedPiece === null || !selectedLive) return null;
  if (selectedPiece.type === 'lift-bridge') {
    return (
      <button
        type="button"
        onClick={onToggleBridgeSpan}
        data-testid={selectedBridgeRaised ? 'action-lower-span' : 'action-raise-span'}
      >
        {selectedBridgeRaised ? 'Lower span' : 'Raise span'}
      </button>
    );
  }
  if (selectedPiece.type === 'turntable') {
    return (
      <button type="button" onClick={onSpinDeck} data-testid="action-spin-deck">
        Spin deck
      </button>
    );
  }
  if (selectedPiece.type === 'crane-station') {
    return (
      <>
        <button
          type="button"
          onClick={onLiftCrate}
          disabled={!craneCanLift}
          data-testid="action-lift-crate"
          title="Lift a crate off the wagon under the hook onto the stack"
        >
          Lift crate
        </button>
        <button
          type="button"
          onClick={onPlaceCrate}
          disabled={!craneCanPlace}
          data-testid="action-place-crate"
          title="Place a crate from the stack onto the empty wagon under the hook"
        >
          Place crate
        </button>
      </>
    );
  }
  return null;
}

function ActionBar({
  selectedPiece,
  selectedLive,
  selectedPoweredOff,
  onRotate,
  onFlip,
  onDelete,
  onTogglePower,
  selectedBridgeRaised,
  onToggleBridgeSpan,
  onSpinDeck,
  craneCanLift,
  craneCanPlace,
  onLiftCrate,
  onPlaceCrate,
  armedType,
  activeLayer,
  maxLevel,
  onActiveLayerChange,
}: ActionBarProps) {
  // The explicit power affordance: shown only when the selected piece is a live
  // train. Clicking a live train's body selects it (not power off), so this
  // button is how the operator toggles its power. It toggles in place — never
  // despawns the train or publishes `device_disconnected`.
  const canTogglePower = selectedPiece !== null && selectedLive && selectedPiece.type === 'train';
  return (
    <div className="tf-toytable__actions">
      <button type="button" onClick={onRotate} disabled={selectedPiece === null}>
        Rotate (R)
      </button>
      <button type="button" onClick={onFlip} disabled={selectedPiece === null}>
        Flip (F)
      </button>
      <button type="button" onClick={onDelete} disabled={selectedPiece === null}>
        Delete (Del)
      </button>
      {canTogglePower && (
        <button
          type="button"
          onClick={onTogglePower}
          data-testid={selectedPoweredOff ? 'action-power-on' : 'action-power-off'}
        >
          {selectedPoweredOff ? 'Power on' : 'Power off'}
        </button>
      )}
      <ExperimentActions
        selectedPiece={selectedPiece}
        selectedLive={selectedLive}
        selectedBridgeRaised={selectedBridgeRaised}
        onToggleBridgeSpan={onToggleBridgeSpan}
        onSpinDeck={onSpinDeck}
        craneCanLift={craneCanLift}
        craneCanPlace={craneCanPlace}
        onLiftCrate={onLiftCrate}
        onPlaceCrate={onPlaceCrate}
      />
      {/* Deck selector. Grows with the layout: one button per deck from Ground
        up to the highest in use (or the active one), plus "+ Add level" to
        author one deck higher. No fixed two-deck cap. */}
      <span className="tf-toytable__layer-selector" aria-label="Active layer">
        {Array.from({ length: maxLevel + 1 }, (_, i) => i).map((layer) => (
          <button
            key={`deck-${layer}`}
            type="button"
            onClick={() => onActiveLayerChange(layer)}
            aria-pressed={activeLayer === layer}
            className={`tf-toytable__layer-button${activeLayer === layer ? ' tf-toytable__layer-button--active' : ''}`}
            data-testid={`active-layer-${layer}`}
          >
            {layerLabel(layer)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onActiveLayerChange(maxLevel + 1)}
          className="tf-toytable__layer-button tf-toytable__layer-button--add"
          data-testid="add-level"
          title={`Add ${layerLabel(maxLevel + 1)}`}
        >
          + Add level
        </button>
      </span>
      <span className="tf-toytable__status">
        {actionBarStatus(selectedPiece, selectedLive, selectedPoweredOff, armedType)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table (canvas)
// ---------------------------------------------------------------------------

interface TableProps {
  readonly pieces: ReadonlyArray<TrackPiece>;
  readonly liveIds: ReadonlySet<string>;
  /** Subset of live train ids powered OFF in place (rendered dark / inert). */
  readonly poweredOffIds: ReadonlySet<string>;
  readonly selectedId: string | null;
  readonly armedType: TrackPieceType | null;
  /** The deck new pieces land on / snapping is gated to (0 = ground). */
  readonly activeLayer: number;
  /** The live hardware, used to read each live train's current edge so it draws
   * on the higher of its edge's two layers while crossing a bridge. Null until
   * the in-browser sim is up. */
  readonly hardware: ToyHardware | null;
  /**
   * Pre-computed train→carriages coupling map (from `computeTrainTrails`).
   * Passed from the parent so coupling and render-position logic share one
   * computation.
   */
  readonly trainTrails: ReadonlyMap<string, string[]>;
  /**
   * World positions to render live trains + coupled carriages at, derived from
   * the sim each RAF tick. When empty the renderer falls back to
   * `piece.position` (carriages not yet coupled / train deferred).
   */
  readonly renderPositions: ReadonlyMap<string, WorldPosition>;
  /** Live moving-part state for the experimental pieces, read off the sim. */
  readonly experimentVisuals: ReadonlyMap<string, ExperimentVisual>;
  readonly onCanvasClick: (
    xMm: number,
    yMm: number,
    type?: TrackPieceType,
    rotation?: RotationDeg,
  ) => void;
  /** Reposition an already-placed piece (pointer-dragged across the canvas). */
  readonly onMovePiece: (pieceId: string, xMm: number, yMm: number) => void;
  /** Begin scanning a piece (pointer-dragged onto the scan box). */
  readonly onScanPiece: (pieceId: string) => void;
  readonly onPieceAction: (pieceId: string, action: 'select' | PowerToggleAction) => void;
}

function Table({
  pieces,
  liveIds,
  poweredOffIds,
  selectedId,
  armedType,
  activeLayer,
  hardware,
  trainTrails,
  renderPositions,
  experimentVisuals,
  onCanvasClick,
  onMovePiece,
  onScanPiece,
  onPieceAction,
}: TableProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  /** Live world *pose* of the piece currently being pointer-dragged. Carries
   * rotation as well as position so the preview shows the snapped pose the
   * release will commit — what-you-see-is-what-you-get, no jump on release. */
  const [pieceDragPreview, setPieceDragPreview] = useState<{
    id: string;
    x: number;
    y: number;
    rotationDeg: RotationDeg;
  } | null>(null);

  // Build reverse map: carriageId → trainPieceId (for data-coupled-to attr)
  const carriageCoupledTo = new Map<string, string>();
  for (const [trainId, carriageIds] of trainTrails) {
    for (const carriageId of carriageIds) {
      carriageCoupledTo.set(carriageId, trainId);
    }
  }
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });

  /** Canvas box aspect (height ÷ width). Tracks the rendered `<svg>` so the
   * world window (viewBox) matches the box and the table fills it without
   * distorting the rails. Defaults to the legacy 3:2; the ResizeObserver is
   * skipped where unavailable (jsdom), keeping tests on the fixed 900×600 world. */
  const [boxAspect, setBoxAspect] = useState(CANVAS_H_MM / CANVAS_W_MM);
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = svg.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setBoxAspect(r.height / r.width);
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  /** The open endpoint a dragged toybox piece will snap onto, highlighted
   * during dragover. */
  const [snapHighlight, setSnapHighlight] = useState<SnapTarget | null>(null);

  // Pan state stored in refs — no render needed while panning in progress.
  const isPanningRef = useRef(false);
  const panStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const panStartViewportRef = useRef<Viewport | null>(null);

  /** Tracks whether a pan gesture moved enough to suppress the click-to-place. */
  const movedDuringPanRef = useRef(false);
  const suppressNextClickRef = useRef(false);

  // Attach a non-passive wheel listener so we can call preventDefault() to
  // block page scroll while zooming on the canvas.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = svg?.getBoundingClientRect() ?? new DOMRect();
      setViewport((prev) => zoomAtCursor(prev, rect, e.clientX, e.clientY, e.deltaY));
    }
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  function getRect(): DOMRect {
    return svgRef.current?.getBoundingClientRect() ?? new DOMRect();
  }

  function handlePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    // Middle mouse always pans. Left mouse pans only when nothing is armed
    // and the pointer is on the background canvas (not a piece).
    const isMiddle = e.button === 1;
    const isLeftOnBackground = e.button === 0 && armedType === null && e.target === e.currentTarget;
    if (!isMiddle && !isLeftOnBackground) return;

    e.preventDefault();
    isPanningRef.current = true;
    movedDuringPanRef.current = false;
    panStartClientRef.current = { x: e.clientX, y: e.clientY };
    panStartViewportRef.current = viewport;
    const svg = e.currentTarget;
    if (typeof svg.setPointerCapture === 'function') {
      svg.setPointerCapture(e.pointerId);
    }
  }

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!isPanningRef.current) return;
    if (panStartClientRef.current === null || panStartViewportRef.current === null) return;

    const dx = e.clientX - panStartClientRef.current.x;
    const dy = e.clientY - panStartClientRef.current.y;

    // Track movement to suppress the click-to-place on pointer-up.
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      movedDuringPanRef.current = true;
    }

    const rect = getRect();
    const worldW = CANVAS_W_MM / panStartViewportRef.current.zoom;
    const worldH = rect.width > 0 ? worldW * (rect.height / rect.width) : CANVAS_H_MM;
    const dxMm = rect.width > 0 ? -(dx / rect.width) * worldW : 0;
    const dyMm = rect.height > 0 ? -(dy / rect.height) * worldH : 0;

    setViewport({
      x: panStartViewportRef.current.x + dxMm,
      y: panStartViewportRef.current.y + dyMm,
      zoom: panStartViewportRef.current.zoom,
    });
  }

  function handlePointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!isPanningRef.current) return;
    isPanningRef.current = false;
    panStartClientRef.current = null;
    panStartViewportRef.current = null;
    const svg = e.currentTarget;
    if (typeof svg.releasePointerCapture === 'function') {
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        // jsdom may throw if the pointer was never captured.
      }
    }
    if (movedDuringPanRef.current) {
      suppressNextClickRef.current = true;
    }
    movedDuringPanRef.current = false;
  }

  function handleClick(e: React.MouseEvent<SVGSVGElement>) {
    // Suppress click immediately after a pan gesture.
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    const rect = getRect();
    const { x: xMm, y: yMm } = clientToMm(rect, e.clientX, e.clientY, viewport);
    // With nothing armed, a click just clears the selection.
    if (armedType === null) {
      onCanvasClick(xMm, yMm);
      return;
    }
    // Armed: snap + orient the new piece to continue from a nearby open
    // endpoint so curved loops can be built by clicking, not pixel-nudging.
    // Gated to the active layer so an upper-deck piece ignores ground joints.
    const placement = computePlacement(xMm, yMm, armedType, pieces, false, activeLayer);
    onCanvasClick(placement.x, placement.y, armedType, placement.rotationDeg);
  }

  // The canvas behaves as a placement surface, not an interactive control —
  // pieces and the toybox buttons handle keyboard. We still satisfy the
  // useKeyWithClickEvents rule by exposing an Enter/Space → "place at centre"
  // shortcut that mirrors a click; useful for keyboard-only operators.
  function handleKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onCanvasClick(CANVAS_W_MM / 2, CANVAS_H_MM / 2);
    }
  }

  // ---------------------------------------------------------------------------
  // HTML5 drag-from-toybox: dragover + drop on the canvas
  // ---------------------------------------------------------------------------

  function handleDragOver(e: React.DragEvent<SVGSVGElement>) {
    // Only toybox drags use HTML5 DnD onto the canvas (the toybox entries are
    // HTML buttons). Placed pieces are SVG and are repositioned with pointer
    // events instead (see PieceRenderer), not dropped here.
    if (!e.dataTransfer.types.includes(TOYBOX_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    // Preview where the dragged piece will snap. The dragged type isn't
    // readable mid-drag, so highlight the nearest open endpoint (the join a
    // track piece would orient onto); harmless for device drags.
    const { x: xMm, y: yMm } = clientToMm(getRect(), e.clientX, e.clientY, viewport);
    setSnapHighlight(nearestConnectablePoint(xMm, yMm, pieces));
  }

  function handleDragLeave() {
    setSnapHighlight(null);
  }

  function handleDrop(e: React.DragEvent<SVGSVGElement>) {
    e.preventDefault();
    setSnapHighlight(null);

    const rect = getRect();
    const { x: xMm, y: yMm } = clientToMm(rect, e.clientX, e.clientY, viewport);

    // A new piece dragged in from the toybox. Snap + auto-orient it onto a
    // nearby open end exactly like the click and move paths do, so dragging a
    // piece in connects it instead of dropping it loose.
    const pieceType = e.dataTransfer.getData(TOYBOX_DRAG_MIME) as TrackPieceType | '';
    if (pieceType === '') return;
    const placement = computePlacement(xMm, yMm, pieceType, pieces, false, activeLayer);
    onCanvasClick(placement.x, placement.y, pieceType, placement.rotationDeg);
  }

  // ---------------------------------------------------------------------------
  // Pointer-drag of a placed piece (move across canvas, or scan onto the bus)
  // ---------------------------------------------------------------------------

  function handlePieceDragMove(pieceId: string, clientX: number, clientY: number) {
    const { x, y } = clientToMm(getRect(), clientX, clientY, viewport);
    const moving = pieces.find((p) => p.id === pieceId);
    if (moving === undefined) {
      setPieceDragPreview({ id: pieceId, x, y, rotationDeg: 0 });
      return;
    }
    // Preview the *snapped* pose: bring the piece's end near a neighbour's open
    // end and it visibly clicks into the joint, oriented to continue. Release
    // commits exactly this (movePiece runs the same placement on the same mm).
    const others = pieces.filter((p) => p.id !== pieceId);
    const placement = computeMovePlacement(moving, x, y, others);
    setPieceDragPreview({
      id: pieceId,
      x: placement.x,
      y: placement.y,
      rotationDeg: placement.rotationDeg,
    });
  }

  function handlePieceDragEnd(pieceId: string, clientX: number, clientY: number) {
    setPieceDragPreview(null);
    // Released over the scan box → scan it (same confirm flow as an HTML5 drop).
    const target =
      typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(clientX, clientY)
        : null;
    if (target?.closest('[data-testid="scan-box"]') != null) {
      onScanPiece(pieceId);
      return;
    }
    // Otherwise reposition it where it was released.
    const { x, y } = clientToMm(getRect(), clientX, clientY, viewport);
    onMovePiece(pieceId, x, y);
  }

  // Cursor logic: crosshair when armed, grabbing while panning, default otherwise.
  const cursor = armedType !== null ? 'crosshair' : isPanningRef.current ? 'grabbing' : 'default';

  const viewBox = `${viewport.x} ${viewport.y} ${CANVAS_W_MM / viewport.zoom} ${worldHeightMm(viewport.zoom, boxAspect)}`;

  // Bucket pieces by their *effective* layer so lower decks paint first and the
  // upper deck (and any train crossing it) paints last — giving free occlusion
  // of the ground loop under a bridge with opaque fills. A live train reads the
  // higher of its current edge's two layers so it draws ON TOP of the ground
  // loop it crosses mid-bridge, not under it.
  const sim = hardware?.getSimulation();
  const piecesById = new Map<string, TrackPiece>();
  for (const p of pieces) piecesById.set(p.id, p);
  const layerOfPiece = (p: TrackPiece): number =>
    sim !== undefined ? effectiveLayer(p, sim, carriageCoupledTo, piecesById) : layerOf(p);
  const byLayer = new Map<number, TrackPiece[]>();
  for (const p of pieces) {
    const layer = layerOfPiece(p);
    const bucket = byLayer.get(layer);
    if (bucket === undefined) byLayer.set(layer, [p]);
    else bucket.push(p);
  }
  const orderedLayers = [...byLayer.keys()].sort((a, b) => a - b);

  // Same-layer track-on-track overlap detection: two track pieces sharing a 2D
  // footprint on the SAME layer with no shared endpoint is an authoring mistake
  // (a bridge crossing is the legitimate different-layer case, never flagged).
  // Offending pieces get a red error outline; the status bar surfaces a count.
  const overlapIds = detectSameLayerOverlaps(pieces);

  return (
    <>
      {overlapIds.size > 0 && (
        <div className="tf-toytable__overlap-warning" role="alert" data-testid="overlap-warning">
          ⚠ {overlapIds.size} track piece{overlapIds.size === 1 ? '' : 's'} overlap on the same
          layer with no shared join — move or delete the highlighted pieces.
        </div>
      )}
      <svg
        ref={svgRef}
        width={CANVAS_W_MM * SCALE}
        height={CANVAS_H_MM * SCALE}
        viewBox={viewBox}
        className="tf-toytable__canvas"
        style={{ cursor }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="img"
        aria-label="Toy table"
        data-testid="toy-table-canvas"
        data-viewport-zoom={viewport.zoom}
        data-viewport-x={viewport.x}
        data-viewport-y={viewport.y}
      >
        {/* One group per layer, lowest first, so higher decks paint last and a
          bridge reads as over/under. The drop-shadow height cue is attached to
          this UN-rotated group (never the per-piece rotated/flipped <g>, where a
          shadow would shear and point a different way per piece).

          Within each layer group the paint order is THREE phases:
            1. track pieces (the opaque rail bands),
            2. subtle MARKER DOTS at each non-device piece's centre,
            3. device pieces (trains / gates / carriages).
          So a marker dot sits ABOVE the rail it marks (visible) but BELOW a
          train passing over it (the train is not pierced by the dot). Dots ride
          in their own layer's group, so an upper-deck dot sits on the deck and a
          ground dot beneath a bridge is occluded by the deck above. */}
        {orderedLayers.map((layer) => {
          const layerPieces = byLayer.get(layer) ?? [];
          const trackPieces = layerPieces.filter((p) => !isDevicePiece(p.type));
          const devicePieces = layerPieces.filter((p) => isDevicePiece(p.type));
          const filter = layerFilter(layer);
          /* Support piers for a raised deck: one under each raised track piece,
            dropping by this layer's shadow offset so pier and shadow agree. A
            pier is omitted where track runs directly beneath (a bridge crossing)
            so a column never lands on the rail it spans over. Drawn UNFILTERED,
            before the deck, so the deck body caps each column. */
          const supportColumns =
            layer > 0
              ? trackPieces.flatMap((p) => {
                  if (pierSuppressed(p, pieces)) return [];
                  const column = supportColumn(p, layerStyle(layer).dy);
                  return column !== null ? [{ id: p.id, column }] : [];
                })
              : [];
          /* While a piece is armed for placement, fade decks other than the
            active one so the operator can see which deck a drop will land on —
            the one disambiguation a stacked 2D view needs. Quiet, and only while
            authoring; normal viewing shows every deck at full strength. */
          const dimmed = armedType !== null && layer !== activeLayer;
          const renderPiece = (p: TrackPiece) => (
            <PieceRenderer
              key={p.id}
              piece={p}
              selected={p.id === selectedId}
              live={liveIds.has(p.id)}
              poweredOff={poweredOffIds.has(p.id)}
              armedType={armedType}
              invalidOverlap={overlapIds.has(p.id)}
              coupledToTrainId={carriageCoupledTo.get(p.id)}
              renderPosition={renderPositions.get(p.id)}
              experimentVisual={experimentVisuals.get(p.id)}
              cranePose={
                p.type === 'railyard' && liveIds.has(p.id) ? yardCranePose(p, hardware) : null
              }
              onAction={(action) => onPieceAction(p.id, action)}
              dragOverride={
                pieceDragPreview?.id === p.id
                  ? {
                      x: pieceDragPreview.x,
                      y: pieceDragPreview.y,
                      rotationDeg: pieceDragPreview.rotationDeg,
                    }
                  : undefined
              }
              onDragMove={handlePieceDragMove}
              onDragEnd={handlePieceDragEnd}
            />
          );
          return (
            <g
              key={`layer-${layer}`}
              style={dimmed ? { opacity: 0.4 } : undefined}
              data-dimmed={dimmed || undefined}
            >
              {supportColumns.length > 0 && (
                <g data-testid={`supports-${layer}`}>
                  {supportColumns.map(({ id, column }) => (
                    <SupportLeg key={`support-${id}`} column={column} />
                  ))}
                </g>
              )}
              <g data-layer={layer} style={filter ? { filter } : undefined}>
                {trackPieces.map(renderPiece)}
                {/* Marker dots: one per track piece, at the piece CENTRE (where the
                  layout marker M-{id} sits), painted over the track but under the
                  devices below. Junctions get one too. Subtle + non-interactive. */}
                {trackPieces.map((p) => (
                  <MarkerDot key={`marker-${p.id}`} piece={p} selected={p.id === selectedId} />
                ))}
                {devicePieces.map(renderPiece)}
              </g>
            </g>
          );
        })}
        {/* Snap highlight — a faint ring drawn over the would-snap-to endpoint. */}
        {snapHighlight !== null && (
          <circle
            cx={snapHighlight.x}
            cy={snapHighlight.y}
            r={SNAP_DISTANCE / 2}
            fill="none"
            stroke="#facc15"
            strokeWidth={3}
            strokeOpacity={0.85}
            style={{ pointerEvents: 'none' }}
            data-testid="snap-highlight"
          />
        )}
      </svg>
    </>
  );
}

/** Radius of the subtle centre-marker indicator, in mm. */
const MARKER_DOT_RADIUS = 3;

/**
 * A subtle marker indicator at a track piece's CENTRE — exactly where the
 * layout's `M-{piece.id}` marker sits (`piece.position`). Small, muted, and
 * non-interactive (`pointerEvents: none`), so it reads as a quiet "a marker
 * lives here" dot rather than the old bold endpoint dots. Rendered for every
 * non-device piece including junctions. The selected piece's marker tints to
 * the selection blue. Drawn between the track band and the devices in its layer
 * group, so a train passing over it is never pierced.
 */
function MarkerDot({ piece, selected }: { piece: TrackPiece; selected: boolean }) {
  return (
    <circle
      cx={piece.position.x}
      cy={piece.position.y}
      r={MARKER_DOT_RADIUS}
      fill={selected ? '#2563eb' : '#1f2937'}
      fillOpacity={selected ? 0.85 : 0.45}
      stroke="#fff"
      strokeWidth={0.75}
      strokeOpacity={0.7}
      style={{ pointerEvents: 'none' }}
      data-testid={`marker-${piece.id}`}
    />
  );
}

/**
 * A slim support pier under a raised deck: a darker wood column dropping from the
 * deck underside to a soft contact shadow on the table, in world coordinates.
 * Non-interactive and drawn BENEATH the deck body, so the deck caps the column
 * top and the pier reads as holding it up. Only raised track gets one, and the
 * caller omits it where track runs directly underneath (a bridge crossing).
 */
function SupportLeg({ column }: { column: SupportColumn }) {
  const half = column.width / 2;
  const footY = column.yTop + column.height;
  return (
    <g style={{ pointerEvents: 'none' }} data-testid="support-leg">
      <ellipse cx={column.x} cy={footY} rx={half + 2} ry={2.5} fill="#000" fillOpacity={0.18} />
      <rect
        x={column.x - half}
        y={column.yTop}
        width={column.width}
        height={column.height}
        rx={2}
        fill="url(#tf-pier)"
        stroke="#6f4d20"
        strokeWidth={0.5}
        strokeOpacity={0.6}
      />
    </g>
  );
}

interface PieceRendererProps {
  readonly piece: TrackPiece;
  readonly selected: boolean;
  /** On the bus / scanned (spawned in the sim). For a train this stays true
   * while powered off — power is not lifecycle. */
  readonly live: boolean;
  /** A live train the operator has powered OFF in place: inert and silent,
   * rendered dark at its frozen sim position. */
  readonly poweredOff: boolean;
  readonly armedType: TrackPieceType | null;
  /** When true, this piece is part of an invalid same-layer track-on-track
   * overlap and is drawn with a red error outline. */
  readonly invalidOverlap: boolean;
  /**
   * For carriage pieces: the id of the live train this carriage is currently
   * coupled to (within COUPLING_DISTANCE_MM), or undefined if uncoupled.
   * Undefined for all non-carriage piece types.
   */
  readonly coupledToTrainId: string | undefined;
  /**
   * When set, overrides the piece's `position` and `rotationDeg` for rendering.
   * Used to drive live trains and their coupled carriages from the simulation's
   * physics state. When undefined the renderer falls back to `piece.position`
   * (uncoupled or deferred pieces sit at their placement coordinates).
   */
  readonly renderPosition: WorldPosition | undefined;
  /** Live moving-part state for an experimental piece (deck angle, span
   * raised, LED lit); undefined for pieces with no moving parts. */
  readonly experimentVisual: ExperimentVisual | undefined;
  /** For a railyard piece: the gantry crane's live pose (bridge depth + head
   * lane + working), driving the crane to FOLLOW the interior maneuver tick by
   * tick. Null when the yard isn't shunting (crane parks at home). */
  readonly cranePose: YardCranePose | null;
  readonly onAction: (action: 'select' | PowerToggleAction) => void;
  /**
   * While a pointer-drag of this piece is in progress, the live world position
   * (mm) to render it at — it follows the cursor. Placed pieces are SVG and
   * can't use HTML5 DnD, so repositioning is done with pointer events.
   */
  readonly dragOverride: { x: number; y: number; rotationDeg: number } | undefined;
  /** Pointer moved while dragging this piece (client coords). */
  readonly onDragMove: (pieceId: string, clientX: number, clientY: number) => void;
  /** Drag released (client coords) — reposition the piece, or scan it if let
   * go over the scan box. */
  readonly onDragEnd: (pieceId: string, clientX: number, clientY: number) => void;
}

/** The pointer cursor for a piece body: crosshair while a type is armed
 * (placing), grab otherwise. The body click selects (and a press-drag moves);
 * power-off lives on the power dot, which carries its own pointer cursor. */
function pieceCursor(armed: boolean): string {
  if (armed) return 'crosshair';
  return 'grab';
}

/** The a11y label suffix describing a piece's power state. Empty for a piece
 * not on the bus; otherwise "powered on" (driven) or "powered off" (inert in
 * place). Extracted so `PieceRenderer` stays under the complexity budget. Pure. */
function powerLabelSuffix(live: boolean, powered: boolean): string {
  if (!live) return '';
  return powered ? ' (powered on)' : ' (powered off)';
}

/** A piece's solid body colour: the beech-wood gradient for track, a carriage's
 *  intrinsic livery, or the device's flat colour. (Calls the `isDevicePiece`
 *  type guard so `piece.type` narrows to a `DEVICE_FILL` key.) */
function pieceBodyFill(piece: TrackPiece): string {
  if (!isDevicePiece(piece.type)) return WOOD_FILL;
  if (piece.type === 'carriage') return carriageFill(piece);
  return DEVICE_FILL[piece.type];
}

function PieceRenderer({
  piece,
  selected,
  live,
  poweredOff,
  armedType,
  invalidOverlap,
  coupledToTrainId,
  renderPosition,
  experimentVisual,
  cranePose,
  onAction,
  dragOverride,
  onDragMove,
  onDragEnd,
}: PieceRendererProps) {
  const shape = getPieceShape(piece);
  const isDevice = isDevicePiece(piece.type);
  // Track pieces are filled with the beech-wood gradient + their functional
  // tint; device pieces (train/gate/carriage) get their own solid colour. A
  // carriage's colour is its intrinsic livery (so a wagon stays trackable as it
  // is shunted between trains), defaulting to the standard blue.
  const tint = PIECE_TINT[piece.type];
  const bodyFill = pieceBodyFill(piece);
  // Wire devices (train / gate) can be powered off by clicking when live.
  // Carriages are wire-invisible — clicking a live carriage just selects it.
  const isWire = isWireDevice(piece.type);
  // A train that is on the bus AND not powered off is under power (driven). A
  // powered-off train stays live (on the track, rendered at its frozen sim
  // position) but reads as dark/inert. Gates have no power-off concept.
  const powered = live && !poweredOff;

  // Pointer-drag state. Placed pieces are SVG <g> elements; Chrome does not
  // honour the HTML5 `draggable` attribute on SVG, so native DnD never starts.
  // We drag with pointer events instead (which also gives live feedback and is
  // automatable). A press that doesn't move past the threshold is a click.
  const dragRef = useRef<{ clientX: number; clientY: number; moved: boolean } | null>(null);
  // Set when a drag actually moved the piece, so the click that fires right
  // after pointer-up doesn't also select it.
  const suppressClickRef = useRef(false);

  function handlePointerDown(e: React.PointerEvent<SVGGElement>) {
    // When a piece type is armed the operator is placing, not moving — let the
    // event bubble so the canvas places a fresh piece here. Only the primary
    // button starts a drag.
    if (armedType !== null || e.button > 0) return;
    e.stopPropagation(); // don't start a canvas pan
    dragRef.current = { clientX: e.clientX, clientY: e.clientY, moved: false };
    if (typeof e.currentTarget.setPointerCapture === 'function') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // jsdom / no active pointer — dragging still works without capture.
      }
    }
  }

  function handlePointerMove(e: React.PointerEvent<SVGGElement>) {
    const start = dragRef.current;
    if (start === null) return;
    if (!start.moved && Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) > 4) {
      start.moved = true;
    }
    if (start.moved) onDragMove(piece.id, e.clientX, e.clientY);
  }

  function handlePointerUp(e: React.PointerEvent<SVGGElement>) {
    const start = dragRef.current;
    if (start === null) return;
    dragRef.current = null;
    if (typeof e.currentTarget.releasePointerCapture === 'function') {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // jsdom may throw if the pointer was never captured.
      }
    }
    if (start.moved) {
      suppressClickRef.current = true;
      onDragEnd(piece.id, e.clientX, e.clientY);
    }
  }

  function handleClick(e: React.MouseEvent) {
    // When armed, let the click bubble so the canvas places a fresh piece.
    if (armedType !== null) return;
    // Otherwise this piece owns the click: keep it off the canvas (which would
    // deselect / place).
    e.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return; // the click that closes a drag — not a select.
    }
    // A body click ALWAYS selects — including a live train. It must never
    // toggle the device's power: powering off no longer despawns or teleports
    // the train (it goes inert in place), but the body click still must not
    // trigger it. Power is an explicit affordance: the power dot or the
    // ActionBar button.
    onAction('select');
  }

  // Click the power dot of an on-track train → toggle its power in place. Stops
  // propagation so the body click (which selects) doesn't also fire. On an
  // un-scanned device the dot is inert — the device goes on the bus by being
  // scanned, not by clicking.

  // Keyboard equivalent of the click: Enter/Space selects the piece (rotate and
  // delete then work via the global R / Delete shortcuts).
  function handleKeyDown(e: React.KeyboardEvent) {
    if (armedType !== null || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    e.stopPropagation();
    onAction('select');
  }

  // While dragging, follow the cursor (dragOverride). Otherwise use the
  // simulated world position when available, falling back to placement.
  const x = dragOverride?.x ?? renderPosition?.x ?? piece.position.x;
  const y = dragOverride?.y ?? renderPosition?.y ?? piece.position.y;
  // While dragging, the preview carries the snapped rotation so what's shown is
  // exactly what release commits; otherwise follow the sim, then placement.
  const rotationDeg = dragOverride?.rotationDeg ?? renderPosition?.rotationDeg ?? piece.rotationDeg;

  // Contact shadow always, with a blue (selection) or red (invalid overlap) glow
  // layered on top — a glow not a stroke, so a multi-plank piece (junction,
  // crossing) never shows a seam where its sub-paths meet.
  const filter = pieceFilter(invalidOverlap, selected);
  const cursorStyle = pieceCursor(armedType !== null);
  // A device that is not under power dims to read as inert / off-bus.
  const dim = isDevice && !powered ? 0.5 : 1;
  // A powered-off train is on the bus but inert: label it distinctly so the
  // a11y tree and screenshots can tell "powered off in place" from "off the
  // bus" and from "driven".
  const ariaLabel = `${piece.type} piece${powerLabelSuffix(live, powered)}${invalidOverlap ? ' (invalid overlap)' : ''}`;

  return (
    <g
      transform={`translate(${x}, ${y}) rotate(${rotationDeg}) scale(1, ${piece.flipped === true ? -1 : 1})`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={{ cursor: cursorStyle, touchAction: 'none', filter }}
      data-testid={`piece-${piece.id}`}
      data-piece-id={piece.id}
      data-live={live ? 'true' : 'false'}
      data-powered={powered ? 'true' : 'false'}
      data-coupled-to={coupledToTrainId}
      data-invalid-overlap={invalidOverlap ? 'true' : undefined}
      aria-label={ariaLabel}
    >
      <PieceBody shape={shape} bodyFill={bodyFill} tint={tint} isDevice={isDevice} dim={dim} />
      {/* The moving / lit parts of an experimental piece ride inside the same
          transformed group, over the static body (null for ordinary pieces). */}
      <ExperimentParts pieceId={piece.id} visual={experimentVisual} />
      {/* The railyard's XY gantry: foundations OUTSIDE the slots, a bridge that
          rolls along them, and a crane head that crosses the bridge to reach
          over any slot. Drawn over the wooden track, in the yard's local frame. */}
      {piece.type === 'railyard' && <RailyardGantry cranePose={cranePose} />}
      {/* Power dot for wire-visible devices only (train / gate): green when
          powered, grey when inert/off-bus. Carriages have no wire identity —
          no dot. Clicking the dot of an on-track train toggles its power in
          place; the device body click only selects. */}
      {isWire && (
        <PowerDot
          piece={piece}
          live={live}
          powered={powered}
          armed={armedType !== null}
          cx={shape.width / 2 - POWER_DOT_RADIUS}
          cy={-shape.height / 2 + POWER_DOT_RADIUS}
          onTogglePower={() => onAction({ type: 'power-toggle', pieceId: piece.id })}
        />
      )}
    </g>
  );
}

const RAILYARD_STEEL = '#7c8a94';
const RAILYARD_STEEL_DARK = '#5a6770';
const RAILYARD_STEEL_LIGHT = '#aeb9c1';

/* The gantry's choreography is DRIVEN BY THE WORK, not a blind timer. Its pose
   comes live from the device's interior maneuver (`cranePose`): the bridge sits
   at the crane's depth and the head at its lane, so the gantry FOLLOWS the train
   tick by tick — over the cut it is decoupling, then over the train as it pulls
   forward, reverses into the spares slot, and is read for release. Position is
   plain React transforms (re-rendered each sim tick, like the trains); only the
   working stroke + hum + LED pulse are SMIL, mounted while the crane is actually
   working a cut or reading the train. Idle, with no maneuver, it parks at its
   home end and does nothing. No sweeping empty bays. */
const GX = RAILYARD_GANTRY_X;
/* Hook: a slow lift-and-lower over the coupling — the actual working stroke,
   looped while the crane is working a cut or reading the train. */
const HEAD_LIFT_VALUES = '0 0;0 -7;0 0';
const LED_IDLE = '#4ad7b0';
const LED_WORK = '#ffb52e';
/* LED pulse while working: amber stroke, back to teal, repeating. */
const LED_PULSE_VALUES = `${LED_WORK};${LED_IDLE};${LED_WORK}`;

/**
 * The railyard's XY gantry — a 3D-printer-style frame straddling the yard. Its
 * FOUNDATIONS (the two side rails + feet) sit OUTSIDE the outer slots, running
 * the length of the yard. A BRIDGE spans across them and rolls along their
 * length (local x); a CRANE HEAD rides the bridge and crosses it (local y), so
 * the head can reach any point OVER the track without the foundations ever
 * standing on it. Everything is in the yard's local frame, so it rotates with
 * the piece; the bridge + head follow the live `cranePose` (null = parked home).
 */
function RailyardGantry({ cranePose }: { cranePose: YardCranePose | null }) {
  const railY = RAILYARD_RAIL_Y;
  const railX = GX + 14; // foundations overrun the bridge's travel a touch
  const beam = 5;
  return (
    <g>
      {/* Foundations: the two side rails (along the length, OUTSIDE the slots)
          and a foot at each corner — the only parts that touch the table. */}
      {[-railY, railY].map((y) => (
        <rect
          key={`rail-${y}`}
          x={-railX}
          y={y - beam / 2}
          width={railX * 2}
          height={beam}
          rx={2}
          fill={RAILYARD_STEEL}
        />
      ))}
      {[-railX, railX].flatMap((x) =>
        [-railY, railY].map((y) => (
          <rect
            key={`foot-${x},${y}`}
            x={x - 5}
            y={y - 5}
            width={10}
            height={10}
            rx={2}
            fill={RAILYARD_STEEL_DARK}
          />
        )),
      )}
      <RailyardCrane railY={railY} beam={beam} cranePose={cranePose} />
    </g>
  );
}

/** The rolling bridge + crane head. Split out so the foundations stay static
 *  while this whole group translates along the rails. The bridge sits at the
 *  crane's live depth (or parked at home `-GX` when idle) and the head crosses
 *  the bridge to the crane's live lane — so the gantry follows the interior
 *  maneuver. The working stroke + hum + LED pulse run only while `working`. */
function RailyardCrane({
  railY,
  beam,
  cranePose,
}: {
  railY: number;
  beam: number;
  cranePose: YardCranePose | null;
}) {
  const bridgeX = cranePose?.depthMm ?? -GX;
  const headY = cranePose?.laneMm ?? 0;
  const working = cranePose?.working ?? false;
  const hookDown = cranePose?.hookDown ?? false;
  return (
    <g>
      {/* Bridge rolls along the rails to sit over the crane's working depth;
          parked at home (-GX) when there's no maneuver. */}
      <g transform={`translate(${bridgeX}, 0)`}>
        {/* The bridge: a steel lattice truss spanning the two side rails, a truck
            riding each. The girder reads as the gantry's main beam. */}
        <RailyardTruss railY={railY} />
        {[-railY, railY].map((y) => (
          <rect
            key={`truck-${y}`}
            x={-8}
            y={y - beam / 2 - 2}
            width={16}
            height={beam + 4}
            rx={2}
            fill={RAILYARD_STEEL_DARK}
          />
        ))}
        {/* Crane head: rides the bridge across to the crane's lane (so it sits
            over whatever slot the work is in), and works the hook up-and-down
            over the coupling while the crane is actually working. */}
        <g transform={`translate(0, ${headY})`}>
          <g>
            {hookDown && (
              <animateTransform
                attributeName="transform"
                type="translate"
                values={HEAD_LIFT_VALUES}
                dur="1.6s"
                calcMode="spline"
                keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
                repeatCount="indefinite"
              />
            )}
            <RailyardHead working={working} />
          </g>
        </g>
      </g>
    </g>
  );
}

/** The bridge girder, drawn as a steel lattice truss spanning the side rails
 *  (local y). Two chords with a Warren zigzag of cross-bracing between them and
 *  a few node gussets — the gantry's main beam, in workshop steel. */
function RailyardTruss({ railY }: { railY: number }) {
  const half = 5; // chord offset either side of the bridge centreline
  const bays = 10;
  const step = (railY * 2) / bays;
  let zig = `M ${-half} ${-railY}`;
  const nodes: Array<[number, number]> = [];
  for (let i = 1; i <= bays; i++) {
    const y = -railY + i * step;
    const cx = i % 2 === 0 ? -half : half;
    zig += ` L ${cx} ${y}`;
    nodes.push([cx, y]);
  }
  return (
    <g>
      {/* Two chords running the length of the truss. */}
      <rect x={-half - 1} y={-railY} width={2} height={railY * 2} rx={1} fill={RAILYARD_STEEL} />
      <rect x={half - 1} y={-railY} width={2} height={railY * 2} rx={1} fill={RAILYARD_STEEL} />
      {/* Diagonal lattice web between the chords. */}
      <path
        d={zig}
        fill="none"
        stroke={RAILYARD_STEEL_LIGHT}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      {/* Rivet gussets where the web meets a chord. */}
      {nodes.map(([cx, cy]) => (
        <circle key={`node-${cy}`} cx={cx} cy={cy} r={1.3} fill={RAILYARD_STEEL_DARK} />
      ))}
    </g>
  );
}

/** The crane head itself: a housing carrying a downward CAMERA (the computer-
 *  vision element that reads each wagon's livery) and a status LED. The wedge
 *  that splits couplings is a physical part below the head — not rendered. A
 *  subtle constant jitter is the head's working "vibration". */
function RailyardHead({ working }: { working: boolean }) {
  return (
    <g>
      {/* Vibration: a tiny jitter, additive over the hook's lift — the working
          "hum", running while the crane is working a cut or reading the train. */}
      {working && (
        <animateTransform
          attributeName="transform"
          type="translate"
          additive="sum"
          values="0 0;0.5 0.4;-0.4 0.5;0.4 -0.4;0 0"
          dur="0.22s"
          repeatCount="indefinite"
        />
      )}
      {/* Head housing (the trolley body on the bridge). */}
      <rect x={-11} y={-13} width={22} height={26} rx={4} fill="#2f3a42" />
      <rect
        x={-11}
        y={-13}
        width={22}
        height={26}
        rx={4}
        fill="none"
        stroke={RAILYARD_STEEL_LIGHT}
        strokeWidth={1}
      />
      {/* Camera: a lens housing under the head, looking down at the coupling. */}
      <circle cx={0} cy={3} r={5.5} fill="#11151a" />
      <circle cx={0} cy={3} r={3} fill="#1c3a4a" />
      <circle cx={-1.4} cy={1.6} r={1} fill="#cfe9f2" />
      {/* Status LED on the head's shoulder — pulses amber while working, holds
          teal idle when no train is in the yard. */}
      <circle cx={0} cy={-8} r={2.6} fill={LED_IDLE}>
        {working && (
          <animate
            attributeName="fill"
            values={LED_PULSE_VALUES}
            dur="1.6s"
            repeatCount="indefinite"
          />
        )}
      </circle>
    </g>
  );
}

/**
 * The small power dot on a wire device. Green = under power, grey = inert
 * (powered off in place, or not yet on the bus). Clicking (or Enter/Space on)
 * the dot of an ON-BUS device TOGGLES its power in place (off↔on) — the
 * explicit power affordance, distinct from the device body click which only
 * selects. The toggle never despawns the device or publishes
 * `device_disconnected`. Extracted from PieceRenderer so the power interaction
 * (click + keyboard + a11y wiring) lives in one place and doesn't bloat the
 * renderer's complexity.
 */
function PowerDot({
  piece,
  live,
  powered,
  armed,
  cx,
  cy,
  onTogglePower,
}: {
  readonly piece: TrackPiece;
  readonly live: boolean;
  readonly powered: boolean;
  readonly armed: boolean;
  readonly cx: number;
  readonly cy: number;
  readonly onTogglePower: () => void;
}) {
  // Interactive only for an on-bus TRAIN — clicking it toggles power in place
  // (off↔on). A gate's dot is a status-only cue (green = live): power-in-place
  // is a train concept (VirtualGate has no inert state) and `togglePower`
  // no-ops for non-trains, so making the gate dot a button would be a lying
  // affordance. An un-scanned device's dot is inert too.
  const interactive = live && !armed && piece.type === 'train';
  const fire = (e: React.SyntheticEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    onTogglePower();
  };
  const actionLabel = powered ? `Power off ${piece.type}` : `Power on ${piece.type}`;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={POWER_DOT_RADIUS}
      fill={powered ? '#16a34a' : '#888'}
      stroke="#1c1c1c"
      strokeWidth={1}
      data-testid={`power-${piece.id}`}
      onClick={fire}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fire(e);
        }
      }}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? actionLabel : undefined}
      style={{ cursor: interactive ? 'pointer' : 'default' }}
    />
  );
}

// ---------------------------------------------------------------------------
// Broker-side helpers (scanPiece)
// ---------------------------------------------------------------------------

/**
 * Fire the "device / tag just appeared on the bus" events for a scanned piece.
 *
 * - Track pieces: ensure the GARAGE is registered (once per session), then
 *   emit a `tag_assignment` from GARAGE binding `M-{piece.id}` to the marker
 *   of the appropriate kind. Junction pieces additionally emit a
 *   `device_registered` for the switch motor (`M-{piece.id}` with
 *   `core.controls_switch`) so LearnMode can send `set_switch_position`.
 * - Train pieces: emit a `device_registered` from the train itself.
 * - Gate pieces: emit a `device_registered` from the gate itself.
 * - Carriage pieces: wire-invisible; emit nothing.
 *
 * Returns `true` when this call announced the GARAGE (so the caller can flip
 * its once-only flag). All other calls return `false`.
 */
function scanPiece(client: BrokerClient, piece: TrackPiece, garageRegistered: boolean): boolean {
  // Carriages are wire-invisible: they carry no RFID tag and announce nothing
  // on the bus. Mark as live locally in the caller; emit nothing here.
  if (piece.type === 'carriage') return false;
  if (piece.type === 'train') {
    const device_id = deviceIdForDevicePiece(piece);
    // Announce the train length-aware (train_length_mm > 0). The server's
    // scheduler needs a physical length to serialise a switched junction (it
    // defers releasing the approach block until the head clears the train's
    // own length); a point train would deadlock a diverging junction such as
    // the bridge demo's J1. Mirrors the length spawned into the sim by
    // ToyHardware so the wire payload and physics agree.
    const reg = encodeDeviceEvent('device_registered', device_id, {
      // `core.can_reverse` so the train may be admitted into a railyard zone
      // (ADR-027 — the interior is worked by shunting). Toy locos can be pushed,
      // so every toy-table train declares it.
      capabilities: ['core.controls_motion', 'core.accepts_route', 'core.can_reverse'],
      train_length_mm: TRAIN_LENGTH_MM,
    });
    client.publish(reg.topic, reg.payload);
    return false;
  }
  if (piece.type === 'gate') {
    const device_id = deviceIdForDevicePiece(piece);
    const reg = encodeDeviceEvent('device_registered', device_id, {
      capabilities: ['core.gates_clearance'],
    });
    client.publish(reg.topic, reg.payload);
    return false;
  }
  if (piece.type === 'railyard') {
    // The railyard is itself a length of track (a pass-through yard), so it
    // contributes a marker like any track piece — bound via the GARAGE in the
    // track path below. In ADDITION, it announces gates_zone (admission) +
    // reports_length (it may reconcile a train's length on the way out,
    // ADR-023). Its zone capacity + occupancy arrive separately as
    // zone_state_changed from the sim device. Note: NO early return — fall
    // through so the GARAGE binds its `M-{id}` marker too.
    const device_id = deviceIdForDevicePiece(piece);
    const reg = encodeDeviceEvent('device_registered', device_id, {
      capabilities: ['core.gates_zone', 'core.reports_length'],
    });
    client.publish(reg.topic, reg.payload);
  }
  // Track piece — announce GARAGE if needed, then bind the tag.
  let announced = false;
  if (!garageRegistered) {
    const reg = encodeDeviceEvent('device_registered', GARAGE_DEVICE_ID, {
      capabilities: ['core.assigns_tags'],
    });
    client.publish(reg.topic, reg.payload);
    announced = true;
  }
  const markerId = `M-${piece.id}`;
  const assignment = encodeDeviceEvent('tag_assignment', GARAGE_DEVICE_ID, {
    tag_id: markerId,
    assigned_kind: 'marker',
    target_id: markerId,
    marker_kind: pieceMarkerKind(piece.type),
  });
  client.publish(assignment.topic, assignment.payload);

  // Some track pieces carry a companion device that registers alongside the
  // marker binding (see TRACK_COMPANION_DEVICES) — a junction's switch motor,
  // or an experimental piece's trackside identity.
  const companion = TRACK_COMPANION_DEVICES[piece.type];
  if (companion !== undefined) {
    const reg = encodeDeviceEvent('device_registered', `${companion.prefix}${piece.id}`, {
      capabilities: [...companion.capabilities],
      ...(companion.controlsMarker === true ? { controls_marker_id: markerId } : {}),
    });
    client.publish(reg.topic, reg.payload);
  }

  return announced;
}

/**
 * Companion device a track piece registers when scanned, alongside its marker
 * tag binding. A junction (and a turntable — experimental 002, the N-way
 * junction) carries a switch motor under `SWITCH-{piece.id}`, declaring
 * `controls_marker_id` so the server can pair marker → device and LearnMode
 * can address `set_switch_position` to the device directly. The experimental
 * pieces carry the device identity their design doc declares — and nothing
 * else: every capability here is an existing public seam.
 */
const TRACK_COMPANION_DEVICES: Partial<
  Record<
    TrackPieceType,
    {
      readonly prefix: string;
      readonly capabilities: ReadonlyArray<string>;
      /** Declare `controls_marker_id` (switch motors only). */
      readonly controlsMarker?: boolean;
    }
  >
> = {
  junction: { prefix: 'SWITCH-', capabilities: ['core.controls_switch'], controlsMarker: true },
  turntable: { prefix: 'SWITCH-', capabilities: ['core.controls_switch'], controlsMarker: true },
  // Experimental 001: the authority to assert a train_length_mm (ADR-023).
  'vision-station': { prefix: 'VLS-', capabilities: ['core.reports_length'] },
  // Experimental 003: pin a dwelling train during a lift — never a dwell timer.
  'crane-station': { prefix: 'CRANE-', capabilities: ['core.gates_clearance'] },
  // Experimental 005: clearance as physical track availability — span up ⇒ withhold.
  'lift-bridge': { prefix: 'BRIDGE-', capabilities: ['core.gates_clearance'] },
};
