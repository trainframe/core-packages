import { Panel } from '@trainframe/ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerClient } from '../broker/client.js';
import { encodeDeviceEvent } from '../broker/encode-event.js';
import { buildBridgeDemo } from '../demo/bridge-demo.js';
import { nearestStartEdge } from '../sim/nearest-edge.js';
import type { ToyHardware } from '../sim/toy-hardware.js';
import { useToyHardware } from '../sim/use-toy-hardware.js';
import { CARRIAGE_SPACING_MM, type WorldPosition, computeTrainTrails } from '../track/coupling.js';
import { type EdgePath, composeEdgePath } from '../track/edge-path.js';
import { SNAP_DISTANCE, compileLayout } from '../track/layout-from-pieces.js';
import { detectSameLayerOverlaps } from '../track/overlap.js';
import {
  PIECE_TINT,
  type PieceFeature,
  type RotationDeg,
  TRAIN_LENGTH_MM,
  type TrackPiece,
  type TrackPieceType,
  getEndpoints,
  getPieceShape,
  isDevicePiece,
  isWireDevice,
  layerOf,
  layerStyle,
  pieceMarkerKind,
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

const TRACK_PIECE_TYPES = [
  'straight',
  'curve',
  'curve-tight',
  'junction',
  'station',
  'terminus',
  'crossing',
  'ramp',
] as const;
const DEVICE_PIECE_TYPES = ['train', 'gate', 'carriage'] as const;

const PIECE_LABELS: Record<TrackPieceType, string> = {
  straight: 'Straight',
  curve: 'Curve',
  'curve-tight': 'Tight Curve',
  junction: 'Junction',
  station: 'Station',
  terminus: 'Terminus',
  crossing: 'Crossing',
  ramp: 'Ramp',
  train: 'Train',
  gate: 'Gate',
  carriage: 'Carriage',
};

/**
 * Device body colours (train/gate/carriage are NOT wooden). Track pieces are
 * filled with the beech-wood gradient + their `PIECE_TINT` wash instead, so they
 * have no entry here.
 */
const DEVICE_FILL: Partial<Record<TrackPieceType, string>> = {
  train: '#cf4436',
  carriage: '#3f6fa6',
  gate: '#8a929c',
};

/** A representative swatch colour for the toybox button border — the device
 * colour for devices, the functional tint (or plain beech) for track. */
const TOYBOX_SWATCH_WOOD = '#c79a5f';
function toyboxSwatch(type: TrackPieceType): string {
  return DEVICE_FILL[type] ?? PIECE_TINT[type] ?? TOYBOX_SWATCH_WOOD;
}

/* SVG gradient/fill ids defined once in the canvas <defs>; referenced by url(). */
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
      {/* Wooden plank (or device body). */}
      <path d={shape.svgPath} fill={bodyFill} />
      {/* Gentle functional colour wash over the wood (track pieces only). */}
      {!isDevice && tint !== null && <path d={shape.svgPath} fill={tint} fillOpacity={0.22} />}
      {/* Soft rim light for a bevelled, raised feel. */}
      <path
        d={shape.svgPath}
        fill="none"
        stroke={isDevice ? '#ffffff' : '#f6e8c9'}
        strokeOpacity={isDevice ? 0.3 : 0.5}
        strokeWidth={1}
      />
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

function placeLiveTrain(
  piece: TrackPiece,
  sim: ToySimulation,
  piecesById: ReadonlyMap<string, TrackPiece>,
  trainTrails: ReadonlyMap<string, ReadonlyArray<string>>,
  result: Map<string, WorldPosition>,
): void {
  const simTrain = sim.getTrain(`T-${piece.id}`);
  if (simTrain === undefined) return;

  const endpoints = resolveEdgeEndpoints(simTrain, piecesById);
  if (endpoints === undefined) return;

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
  const edgeEstLen = (f: string, to: string): number =>
    sim.layout.findEdge(f, to)?.estimated_length_mm ?? 200;

  const carriageIds = trainTrails.get(piece.id) ?? [];
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
    }
  }
  return result;
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
}

declare global {
  interface Window {
    trainframeSim?: TrainframeSimHandle | undefined;
    /** DEV-only seed hook: stages the two-train bridge demo on the table.
     * Registered behind `import.meta.env.DEV`; absent in production builds. */
    __tfLoadBridgeDemo?: (() => void) | undefined;
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
  const worldW = CANVAS_W_MM / viewport.zoom;
  const worldH = CANVAS_H_MM / viewport.zoom;
  const xMm = viewport.x + ((clientX - rect.left) / rect.width) * worldW;
  const yMm = viewport.y + ((clientY - rect.top) / rect.height) * worldH;
  return { x: xMm, y: yMm };
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
    };
    window.trainframeSim = handle;
    return () => {
      // exactOptionalPropertyTypes forbids `delete`; assign undefined.
      window.trainframeSim = undefined;
    };
  }, []);

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
      };
      setPieces((prev) => [...prev, piece]);
      setSelectedId(piece.id);
      // Stay armed so the operator can drop multiple of the same type without
      // re-clicking the toybox.
    },
    [armedType, activeLayer],
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

  // Coupling: derive which carriages are coupled to which live train each render.
  const trainTrails = computeTrainTrails(pieces, liveIds);
  trainTrailsRef.current = trainTrails;

  // Compute render positions from the live simulation. Only non-empty when
  // there are coupled carriages and the train has a resolved sim edge.
  const hardware = hardwareRef.current;
  const hasLiveTrain = pieces.some((p) => p.type === 'train' && liveIds.has(p.id));
  const renderPositions =
    hardware !== null && hasLiveTrain
      ? computeRenderPositions(pieces, liveIds, trainTrails, hardware)
      : new Map<string, WorldPosition>();

  return (
    <div className="tf-toytable">
      <header className="tf-toytable__header">
        <h1>Trainframe Toy Table</h1>
        <ConnectionStatus />
        <Settings initialUrl={initialUrl} />
      </header>
      <div className="tf-toytable__body">
        <aside className="tf-toytable__sidebar">
          <Toybox armedType={armedType} onArm={armPieceType} />
          <ScanBox
            describePiece={describePiece}
            onConfirm={handleScanConfirm}
            onReady={handleScanBoxReady}
          />
        </aside>
        <main className="tf-toytable__main">
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
            armedType={armedType}
            activeLayer={activeLayer}
            onActiveLayerChange={setActiveLayer}
          />
          <Table
            pieces={pieces}
            liveIds={liveIds}
            poweredOffIds={poweredOffIds}
            selectedId={selectedId}
            armedType={armedType}
            activeLayer={activeLayer}
            trainTrails={trainTrails}
            renderPositions={renderPositions}
            hardware={hardware}
            onCanvasClick={placePiece}
            onMovePiece={movePiece}
            onScanPiece={requestScan}
            onPieceAction={handlePiecePointerAction}
          />
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toybox
// ---------------------------------------------------------------------------

interface ToyboxProps {
  readonly armedType: TrackPieceType | null;
  readonly onArm: (type: TrackPieceType) => void;
}

function Toybox({ armedType, onArm }: ToyboxProps) {
  return (
    <Panel label="Toybox" className="tf-toybox">
      <ToyboxGroup heading="Track" types={TRACK_PIECE_TYPES} armedType={armedType} onArm={onArm} />
      <ToyboxGroup
        heading="Devices"
        types={DEVICE_PIECE_TYPES}
        armedType={armedType}
        onArm={onArm}
      />
    </Panel>
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
      style={{ borderColor: toyboxSwatch(type) }}
      data-testid={`toybox-${type}`}
    >
      {PIECE_LABELS[type]}
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
  readonly armedType: TrackPieceType | null;
  /** The deck new pieces land on (0 = ground). */
  readonly activeLayer: number;
  readonly onActiveLayerChange: (layer: number) => void;
}

/** The decks the layer selector offers. Ground + one upper deck cover the
 * bridge demo; extend if deeper stacks are ever authored by hand. */
const SELECTABLE_LAYERS: ReadonlyArray<{ readonly layer: number; readonly label: string }> = [
  { layer: 0, label: 'Ground' },
  { layer: 1, label: 'Upper' },
];

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

function ActionBar({
  selectedPiece,
  selectedLive,
  selectedPoweredOff,
  onRotate,
  onFlip,
  onDelete,
  onTogglePower,
  armedType,
  activeLayer,
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
      <span className="tf-toytable__layer-selector" aria-label="Active layer">
        {SELECTABLE_LAYERS.map(({ layer, label }) => (
          <button
            key={layer}
            type="button"
            onClick={() => onActiveLayerChange(layer)}
            aria-pressed={activeLayer === layer}
            className={`tf-toytable__layer-button${activeLayer === layer ? ' tf-toytable__layer-button--active' : ''}`}
            data-testid={`active-layer-${layer}`}
          >
            {label}
          </button>
        ))}
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
      setViewport((prev) => {
        // Where the cursor is in world space (mm) before the zoom.
        const worldPos = clientToMm(rect, e.clientX, e.clientY, prev);
        const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * zoomFactor));
        // Adjust origin so the cursor stays at the same world position.
        const worldW = CANVAS_W_MM / newZoom;
        const worldH = CANVAS_H_MM / newZoom;
        const fracX = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
        const fracY = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
        return {
          x: worldPos.x - fracX * worldW,
          y: worldPos.y - fracY * worldH,
          zoom: newZoom,
        };
      });
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
    const worldH = CANVAS_H_MM / panStartViewportRef.current.zoom;
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

  const viewBox = `${viewport.x} ${viewport.y} ${CANVAS_W_MM / viewport.zoom} ${CANVAS_H_MM / viewport.zoom}`;

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
        <WoodDefs />
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
            <g key={`layer-${layer}`} data-layer={layer} style={filter ? { filter } : undefined}>
              {trackPieces.map(renderPiece)}
              {/* Marker dots: one per track piece, at the piece CENTRE (where the
                layout marker M-{id} sits), painted over the track but under the
                devices below. Junctions get one too. Subtle + non-interactive. */}
              {trackPieces.map((p) => (
                <MarkerDot key={`marker-${p.id}`} piece={p} selected={p.id === selectedId} />
              ))}
              {devicePieces.map(renderPiece)}
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

function PieceRenderer({
  piece,
  selected,
  live,
  poweredOff,
  armedType,
  invalidOverlap,
  coupledToTrainId,
  renderPosition,
  onAction,
  dragOverride,
  onDragMove,
  onDragEnd,
}: PieceRendererProps) {
  const shape = getPieceShape(piece);
  const isDevice = isDevicePiece(piece.type);
  // Track pieces are filled with the beech-wood gradient + their functional
  // tint; device pieces (train/gate/carriage) get their own solid colour.
  const tint = PIECE_TINT[piece.type];
  const bodyFill = isDevice ? (DEVICE_FILL[piece.type] ?? '#8a929c') : WOOD_FILL;
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
      capabilities: ['core.controls_motion', 'core.accepts_route'],
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

  // Junction pieces also need a switch-motor device so LearnMode can send
  // `set_switch_position` commands to it. The motor registers under
  // `SWITCH-{piece.id}` and declares `controls_marker_id` so the server can
  // build the marker → device pairing. LearnMode then looks up the device id
  // via LayoutState.switchDeviceForMarker and targets the device directly.
  if (piece.type === 'junction') {
    const switchDeviceId = `SWITCH-${piece.id}`;
    const switchReg = encodeDeviceEvent('device_registered', switchDeviceId, {
      capabilities: ['core.controls_switch'],
      controls_marker_id: markerId,
    });
    client.publish(switchReg.topic, switchReg.payload);
  }

  return announced;
}
