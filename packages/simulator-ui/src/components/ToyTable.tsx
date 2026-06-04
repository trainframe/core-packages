import { Panel } from '@trainframe/ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SVGAttributes } from 'react';
import { useBroker } from '../broker/broker-context.js';
import type { BrokerClient } from '../broker/client.js';
import { encodeDeviceEvent } from '../broker/encode-event.js';
import type { ToyHardware } from '../sim/toy-hardware.js';
import { useToyHardware } from '../sim/use-toy-hardware.js';
import {
  CARRIAGE_SPACING_MM,
  type WorldPosition,
  carriageWorldPos,
  computeTrainTrails,
} from '../track/coupling.js';
import { SNAP_DISTANCE } from '../track/layout-from-pieces.js';
import {
  type RotationDeg,
  type TrackPiece,
  type TrackPieceType,
  getEndpoints,
  getPieceShape,
  isDevicePiece,
  isWireDevice,
  pieceMarkerKind,
} from '../track/pieces.js';
import { ConnectionStatus } from './ConnectionStatus.js';
import { ScanBox } from './ScanBox.js';

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
  'junction',
  'station',
  'terminus',
  'crossing',
] as const;
const DEVICE_PIECE_TYPES = ['train', 'gate', 'carriage'] as const;

const PIECE_LABELS: Record<TrackPieceType, string> = {
  straight: 'Straight',
  curve: 'Curve',
  junction: 'Junction',
  station: 'Station',
  terminus: 'Terminus',
  crossing: 'Crossing',
  train: 'Train',
  gate: 'Gate',
  carriage: 'Carriage',
};

const PIECE_FILL: Record<TrackPieceType, string> = {
  straight: '#7b8eac',
  curve: '#7b9cac',
  junction: '#8c7bac',
  station: '#ac9b7b',
  terminus: '#ac7b7b',
  crossing: '#7bac8a',
  train: '#1f6feb',
  gate: '#d97706',
  carriage: '#6b7fa8',
};

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
      fromPos: { readonly x: number; readonly y: number };
      toPos: { readonly x: number; readonly y: number };
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
    fromPos: fromPiece.position,
    toPos: toPiece.position,
    fromMarkerId: edge.from_marker_id,
    toMarkerId: edge.to_marker_id,
  };
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
function computeRenderPositions(
  pieces: ReadonlyArray<TrackPiece>,
  trainTrails: ReadonlyMap<string, ReadonlyArray<string>>,
  hardware: ToyHardware,
): Map<string, WorldPosition> {
  const result = new Map<string, WorldPosition>();

  // Build a quick lookup: pieceId → TrackPiece
  const piecesById = new Map<string, TrackPiece>();
  for (const p of pieces) piecesById.set(p.id, p);

  const sim = hardware.getSimulation();

  for (const [trainPieceId, carriageIds] of trainTrails) {
    const simTrain = sim.getTrain(`T-${trainPieceId}`);
    if (simTrain === undefined) continue;

    const endpoints = resolveEdgeEndpoints(simTrain, piecesById);
    if (endpoints === undefined) continue;

    const { fromPos, toPos, fromMarkerId, toMarkerId } = endpoints;

    // Edge length from sim's LayoutState (matches what VirtualTrain uses).
    const edgeLengthMm = sim.layout.findEdge(fromMarkerId, toMarkerId)?.estimated_length_mm ?? 200;

    const trainDist = simTrain.getDistanceIntoEdge();

    // Train sprite position
    result.set(trainPieceId, carriageWorldPos(fromPos, toPos, edgeLengthMm, trainDist));

    // Carriage positions — clamp to 0 (v1: no multi-edge trailing)
    for (let i = 0; i < carriageIds.length; i++) {
      const carriageId = carriageIds[i];
      if (carriageId === undefined) continue;
      const carriageDist = Math.max(0, trainDist - (i + 1) * CARRIAGE_SPACING_MM);
      result.set(carriageId, carriageWorldPos(fromPos, toPos, edgeLengthMm, carriageDist));
    }
  }

  return result;
}

interface PowerOnAction {
  readonly type: 'power-on';
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
 * Find the snap offset for a candidate piece placement.
 *
 * Given a candidate (x, y, rotationDeg) and the existing placed pieces, if
 * any endpoint of the candidate is within SNAP_DISTANCE_MM of any existing
 * piece's endpoint, return a position offset so the nearest pair of endpoints
 * coincide exactly.  Returns null when no snap candidate is within range.
 */
function findSnapOffset(
  candidateX: number,
  candidateY: number,
  candidateRotation: RotationDeg,
  type: TrackPieceType,
  existingPieces: ReadonlyArray<TrackPiece>,
): { offsetX: number; offsetY: number; snapTarget: SnapTarget } | null {
  // Build a temporary piece to compute its endpoints in world space.
  const candidate: TrackPiece = {
    id: '__snap_candidate__',
    type,
    position: { x: candidateX, y: candidateY },
    rotationDeg: candidateRotation,
    tagged: false,
  };
  const candidateEndpoints = getEndpoints(candidate);
  if (candidateEndpoints.length === 0) return null;

  let bestDist = SNAP_DISTANCE;
  let bestOffset: { offsetX: number; offsetY: number; snapTarget: SnapTarget } | null = null;

  for (const existing of existingPieces) {
    const existingEndpoints = getEndpoints(existing);
    for (const existingEp of existingEndpoints) {
      for (const candidateEp of candidateEndpoints) {
        const dx = existingEp.x - candidateEp.x;
        const dy = existingEp.y - candidateEp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestOffset = {
            offsetX: dx,
            offsetY: dy,
            snapTarget: { x: existingEp.x, y: existingEp.y },
          };
        }
      }
    }
  }

  return bestOffset;
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
export function ToyTable() {
  const { client } = useBroker();
  const [pieces, setPieces] = useState<ReadonlyArray<TrackPiece>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which piece type the operator has "armed" from the toybox, if any. */
  const [armedType, setArmedType] = useState<TrackPieceType | null>(null);
  /** Set of piece IDs whose device is currently live on the broker. */
  const [liveIds, setLiveIds] = useState<ReadonlySet<string>>(() => new Set());
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
    client,
    onTick: () => {
      // Only bump the tick counter when there are coupled carriages — avoids
      // churn on tables with no carriages or no live trains.
      if (trainTrailsRef.current.size > 0) {
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
      const piece: TrackPiece = {
        id: nextPieceId(pieceType),
        type: pieceType,
        position: { x: xMm, y: yMm },
        rotationDeg: rotation ?? 0,
        tagged: false,
      };
      setPieces((prev) => [...prev, piece]);
      setSelectedId(piece.id);
      // Stay armed so the operator can drop multiple of the same type without
      // re-clicking the toybox.
    },
    [armedType],
  );

  const rotateSelected = useCallback(() => {
    if (selectedId === null) return;
    setPieces((prev) =>
      prev.map((p) =>
        p.id === selectedId ? { ...p, rotationDeg: nextRotation(p.rotationDeg) } : p,
      ),
    );
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
    setSelectedId(null);
  }, [selectedId]);

  // Keyboard: R rotates, Delete/Backspace deletes, Escape clears selection.
  useEffect(() => {
    const handlers: Record<string, () => void> = {
      r: rotateSelected,
      R: rotateSelected,
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
  }, [selectedId, rotateSelected, deleteSelected]);

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

  // Click on a live device → power off (emit `device_disconnected`). The UI
  // only routes this action for device pieces (see `PieceRenderer.handleClick`);
  // track pieces don't have their own device so they have no power-off path.
  const handlePiecePointerAction = useCallback(
    (pieceId: string, action: 'select' | PowerOnAction) => {
      if (action === 'select') {
        setSelectedId(pieceId);
        return;
      }
      // Powering a device off — only wire-visible devices (train / gate) can
      // be powered off. Carriages are wire-invisible so this is a no-op for them.
      const piece = piecesRef.current.find((p) => p.id === pieceId);
      if (piece === undefined) return;
      if (!isWireDevice(piece.type)) return;
      const device_id = deviceIdForDevicePiece(piece);
      const { topic, payload } = encodeDeviceEvent('device_disconnected', device_id, {});
      client.publish(topic, payload);
      setLiveIds((prev) => {
        if (!prev.has(piece.id)) return prev;
        const next = new Set(prev);
        next.delete(piece.id);
        return next;
      });
    },
    [client],
  );

  const selectedPiece = pieces.find((p) => p.id === selectedId) ?? null;

  // Coupling: derive which carriages are coupled to which live train each render.
  const trainTrails = computeTrainTrails(pieces, liveIds);
  trainTrailsRef.current = trainTrails;

  // Compute render positions from the live simulation. Only non-empty when
  // there are coupled carriages and the train has a resolved sim edge.
  const hardware = hardwareRef.current;
  const renderPositions =
    hardware !== null && trainTrails.size > 0
      ? computeRenderPositions(pieces, trainTrails, hardware)
      : new Map<string, WorldPosition>();

  return (
    <div className="tf-toytable">
      <header className="tf-toytable__header">
        <h1>Trainframe Toy Table</h1>
        <ConnectionStatus />
      </header>
      <div className="tf-toytable__body">
        <aside className="tf-toytable__sidebar">
          <Toybox armedType={armedType} onArm={armPieceType} />
          <ScanBox describePiece={describePiece} onConfirm={handleScanConfirm} />
        </aside>
        <main className="tf-toytable__main">
          <ActionBar
            selectedPiece={selectedPiece}
            onRotate={rotateSelected}
            onDelete={deleteSelected}
            armedType={armedType}
          />
          <Table
            pieces={pieces}
            liveIds={liveIds}
            selectedId={selectedId}
            armedType={armedType}
            trainTrails={trainTrails}
            renderPositions={renderPositions}
            onCanvasClick={placePiece}
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
      style={{ borderColor: PIECE_FILL[type] }}
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
  readonly onRotate: () => void;
  readonly onDelete: () => void;
  readonly armedType: TrackPieceType | null;
}

function ActionBar({ selectedPiece, onRotate, onDelete, armedType }: ActionBarProps) {
  return (
    <div className="tf-toytable__actions">
      <button type="button" onClick={onRotate} disabled={selectedPiece === null}>
        Rotate (R)
      </button>
      <button type="button" onClick={onDelete} disabled={selectedPiece === null}>
        Delete (Del)
      </button>
      <span className="tf-toytable__status">
        {armedType !== null
          ? `Armed: ${PIECE_LABELS[armedType]} — click or drag to place`
          : selectedPiece !== null
            ? `Selected: ${PIECE_LABELS[selectedPiece.type]} · ${selectedPiece.rotationDeg}°`
            : 'Pick a piece from the toybox'}
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
  readonly selectedId: string | null;
  readonly armedType: TrackPieceType | null;
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
  readonly onPieceAction: (pieceId: string, action: 'select' | PowerOnAction) => void;
}

function Table({
  pieces,
  liveIds,
  selectedId,
  armedType,
  trainTrails,
  renderPositions,
  onCanvasClick,
  onPieceAction,
}: TableProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Build reverse map: carriageId → trainPieceId (for data-coupled-to attr)
  const carriageCoupledTo = new Map<string, string>();
  for (const [trainId, carriageIds] of trainTrails) {
    for (const carriageId of carriageIds) {
      carriageCoupledTo.set(carriageId, trainId);
    }
  }
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });

  /** The piece type currently being dragged from the toybox. Stored in state
   * so the dragover handler can compute snap candidates without being able to
   * read dataTransfer (forbidden by HTML5 security during dragover). */
  const [draggingToyboxType, setDraggingToyboxType] = useState<TrackPieceType | null>(null);

  /** The snap highlight target while a toybox piece is being dragged. */
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
    onCanvasClick(xMm, yMm);
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
    // Only accept toybox-type drags; reject piece-to-scan-box drags.
    if (!e.dataTransfer.types.includes(TOYBOX_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    if (draggingToyboxType === null) return;
    const rect = getRect();
    const { x: xMm, y: yMm } = clientToMm(rect, e.clientX, e.clientY, viewport);

    // Compute snap highlight during drag.
    const snap = findSnapOffset(xMm, yMm, 0, draggingToyboxType, pieces);
    setSnapHighlight(snap !== null ? snap.snapTarget : null);
  }

  function handleDragLeave() {
    setSnapHighlight(null);
  }

  function handleDrop(e: React.DragEvent<SVGSVGElement>) {
    e.preventDefault();
    setSnapHighlight(null);
    setDraggingToyboxType(null);

    const pieceType = e.dataTransfer.getData(TOYBOX_DRAG_MIME) as TrackPieceType | '';
    if (pieceType === '') return;

    const rect = getRect();
    const { x: xMm, y: yMm } = clientToMm(rect, e.clientX, e.clientY, viewport);

    // Apply snap offset if applicable.
    const snap = findSnapOffset(xMm, yMm, 0, pieceType, pieces);
    const finalX = snap !== null ? xMm + snap.offsetX : xMm;
    const finalY = snap !== null ? yMm + snap.offsetY : yMm;

    onCanvasClick(finalX, finalY, pieceType, 0);
  }

  // Cursor logic: crosshair when armed, grabbing while panning, default otherwise.
  const cursor = armedType !== null ? 'crosshair' : isPanningRef.current ? 'grabbing' : 'default';

  const viewBox = `${viewport.x} ${viewport.y} ${CANVAS_W_MM / viewport.zoom} ${CANVAS_H_MM / viewport.zoom}`;

  return (
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
      {pieces.map((p) => (
        <PieceRenderer
          key={p.id}
          piece={p}
          selected={p.id === selectedId}
          live={liveIds.has(p.id)}
          armedType={armedType}
          coupledToTrainId={carriageCoupledTo.get(p.id)}
          renderPosition={renderPositions.get(p.id)}
          onAction={(action) => onPieceAction(p.id, action)}
          onToyboxDragStart={setDraggingToyboxType}
        />
      ))}
      {/* Endpoint dots for track pieces only. Devices have no endpoints. */}
      <g>
        {pieces.flatMap((p) =>
          getEndpoints(p).map((ep, ei) => (
            <circle
              key={`${p.id}-ep${ei}`}
              cx={ep.x}
              cy={ep.y}
              r={4}
              fill={p.id === selectedId ? '#2563eb' : '#e11d48'}
              stroke="#fff"
              strokeWidth={1.5}
              style={{ pointerEvents: 'none' }}
            />
          )),
        )}
      </g>
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
  );
}

interface PieceRendererProps {
  readonly piece: TrackPiece;
  readonly selected: boolean;
  readonly live: boolean;
  readonly armedType: TrackPieceType | null;
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
  readonly onAction: (action: 'select' | PowerOnAction) => void;
  /** Notifies Table of the type being dragged from the toybox area, so snap
   * highlighting can work during dragover (dataTransfer not readable then). */
  readonly onToyboxDragStart: (type: TrackPieceType | null) => void;
}

function PieceRenderer({
  piece,
  selected,
  live,
  armedType,
  coupledToTrainId,
  renderPosition,
  onAction,
  onToyboxDragStart,
}: PieceRendererProps) {
  const shape = getPieceShape(piece);
  const fill = PIECE_FILL[piece.type];
  const isDevice = isDevicePiece(piece.type);
  // Wire devices (train / gate) can be powered off by clicking when live.
  // Carriages are wire-invisible — clicking a live carriage just selects it.
  const isWire = isWireDevice(piece.type);

  function handleClick(e: React.MouseEvent) {
    // When the operator has a piece type armed, clicks anywhere on the canvas
    // (including on top of existing pieces) place a fresh piece. The piece's
    // own select / power-off handling only applies when nothing is armed.
    // Without this, you can't drop a train onto a straight you just placed,
    // because the click hits the straight and selects it instead.
    if (armedType !== null) return;
    e.stopPropagation();
    if (live && isWire) {
      onAction({ type: 'power-on', pieceId: piece.id });
      return;
    }
    onAction('select');
  }

  function handleDragStart(e: React.DragEvent) {
    // Piece-to-scan-box drag: use the scan-box MIME type.
    e.dataTransfer.setData('application/x-trainframe-piece', piece.id);
    e.dataTransfer.effectAllowed = 'move';
    // Ensure dragging a placed piece doesn't bleed into the snap-highlight
    // logic (which is only for toybox drags).
    onToyboxDragStart(null);
  }

  // Use the simulated world position when available; fall back to the piece's
  // static placement position for uncoupled / deferred pieces.
  const x = renderPosition?.x ?? piece.position.x;
  const y = renderPosition?.y ?? piece.position.y;
  const rotationDeg = renderPosition?.rotationDeg ?? piece.rotationDeg;

  // `draggable` is an HTML attribute that also works on SVG nodes but isn't in
  // React's `SVGProps` type. Pass it through a typed extra-props object rather
  // than reach for `any`.
  const draggableProps: SVGAttributes<SVGGElement> & { draggable: boolean } = {
    draggable: true,
  };

  return (
    <g
      transform={`translate(${x}, ${y}) rotate(${rotationDeg})`}
      onClick={handleClick}
      onDragStart={handleDragStart}
      {...draggableProps}
      style={{ cursor: live && isWire ? 'pointer' : 'grab' }}
      data-testid={`piece-${piece.id}`}
      data-piece-id={piece.id}
      data-live={live ? 'true' : 'false'}
      data-coupled-to={coupledToTrainId}
      aria-label={`${piece.type} piece${live ? ' (powered on)' : ''}`}
    >
      {selected && (
        <path d={shape.svgPath} fill="none" stroke="#2563eb" strokeWidth={6} strokeOpacity={0.4} />
      )}
      <path
        d={shape.svgPath}
        fill={fill}
        stroke="#333"
        strokeWidth={1.5}
        fillOpacity={isDevice && !live ? 0.4 : 1}
      />
      {/* Power dot for wire-visible devices only (train / gate): green when
          live, grey when inert. Carriages have no wire identity — no dot. */}
      {isWire && (
        <circle
          cx={shape.width / 2 - POWER_DOT_RADIUS}
          cy={-shape.height / 2 + POWER_DOT_RADIUS}
          r={POWER_DOT_RADIUS}
          fill={live ? '#16a34a' : '#888'}
          stroke="#1c1c1c"
          strokeWidth={1}
          data-testid={`power-${piece.id}`}
        />
      )}
    </g>
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
    const reg = encodeDeviceEvent('device_registered', device_id, {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
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
  // `set_switch_position` commands to the junction. The motor's device_id
  // matches the junction marker id — this is the id LearnMode targets when
  // it sends `set_switch_position` commands (it uses the marker id, not a
  // separate "SWITCH-" identifier).
  if (piece.type === 'junction') {
    const switchReg = encodeDeviceEvent('device_registered', markerId, {
      capabilities: ['core.controls_switch'],
    });
    client.publish(switchReg.topic, switchReg.payload);
  }

  return announced;
}
