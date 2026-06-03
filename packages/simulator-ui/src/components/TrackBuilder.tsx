import type { Layout } from '@trainframe/protocol';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { compileLayout } from '../track/layout-from-pieces.js';
import { getEndpoints, getPieceShape } from '../track/pieces.js';
import type { RotationDeg, TrackPiece, TrackPieceType } from '../track/pieces.js';

// Canvas scale: 1 mm = SCALE px.  At 2px/mm an 8-piece (8×200mm = 1600mm wide) layout
// fits comfortably in ~800 px of canvas.
const SCALE = 2;
// Default canvas size in mm.
const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;

const PIECE_TYPES: TrackPieceType[] = [
  'straight',
  'curve',
  'junction',
  'station',
  'terminus',
  'crossing',
];

const PIECE_LABELS: Record<TrackPieceType, string> = {
  straight: 'Straight',
  curve: 'Curve',
  junction: 'Junction',
  station: 'Station',
  terminus: 'Terminus',
  crossing: 'Crossing',
};

// Fill colours per piece type (light neutral palette).
const PIECE_FILL: Record<TrackPieceType, string> = {
  straight: '#7b8eac',
  curve: '#7b9cac',
  junction: '#8c7bac',
  station: '#ac9b7b',
  terminus: '#ac7b7b',
  crossing: '#7bac8a',
};

let pieceCounter = 0;
function nextPieceId(): string {
  pieceCounter += 1;
  return `piece-${pieceCounter}`;
}

function nextRotation(r: RotationDeg): RotationDeg {
  const next = (r + 45) % 360;
  return next as RotationDeg;
}

/** Dispatch table for keyboard shortcut keys → action name. */
type KeyAction = 'rotate' | 'delete' | 'tag';
const KEY_ACTION: Readonly<Record<string, KeyAction>> = {
  r: 'rotate',
  R: 'rotate',
  Delete: 'delete',
  Backspace: 'delete',
  t: 'tag',
  T: 'tag',
};

export interface TrackBuilderProps {
  /** Called when the operator confirms the layout. */
  readonly onApply: (layout: Layout) => void;
}

/**
 * Visual track builder palette. Operators click piece buttons to add pieces
 * to a canvas, select/rotate/delete them, and apply the resulting layout.
 *
 * Per ADR-013 this component lives in simulator-ui (the physical twin surface).
 * Marker labels are NOT shown on the canvas; only the physical piece shapes
 * and their endpoint dots appear.
 */
export function TrackBuilder({ onApply }: TrackBuilderProps) {
  const [pieces, setPieces] = useState<ReadonlyArray<TrackPiece>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layoutNameId = useId();
  const [layoutName, setLayoutName] = useState('my-track');

  // Offset each new piece so they don't all stack.
  const placementOffsetRef = useRef(0);

  const selectedPiece = pieces.find((p) => p.id === selectedId) ?? null;

  function addPiece(type: TrackPieceType) {
    const offset = placementOffsetRef.current;
    placementOffsetRef.current = (offset + 30) % 120;
    const newPiece: TrackPiece = {
      id: nextPieceId(),
      type,
      position: {
        x: CANVAS_W_MM / 2 + offset,
        y: CANVAS_H_MM / 2 + offset,
      },
      rotationDeg: 0,
      tagged: false,
    };
    setPieces((prev) => [...prev, newPiece]);
    setSelectedId(newPiece.id);
  }

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
    setSelectedId(null);
  }, [selectedId]);

  const toggleTagSelected = useCallback(() => {
    if (selectedId === null) return;
    setPieces((prev) => prev.map((p) => (p.id === selectedId ? { ...p, tagged: !p.tagged } : p)));
  }, [selectedId]);

  // Keyboard shortcuts when a piece is selected.
  useEffect(() => {
    function dispatchKeyAction(action: KeyAction) {
      if (action === 'rotate') rotateSelected();
      else if (action === 'delete') deleteSelected();
      else toggleTagSelected();
    }

    function onKeyDown(e: KeyboardEvent) {
      // Don't capture when a text input is focused.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (selectedId === null) return;
      const action = KEY_ACTION[e.key];
      if (action !== undefined) {
        e.preventDefault();
        dispatchKeyAction(action);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, rotateSelected, deleteSelected, toggleTagSelected]);

  const compiled = compileLayout(pieces, layoutName);
  const markerCount = compiled.markers.length;
  const edgeCount = compiled.edges.length;

  function handleApply() {
    onApply(compiled);
  }

  function handleCanvasKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'Escape') setSelectedId(null);
  }

  return (
    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
      {/* Palette */}
      <fieldset
        aria-label="Track piece palette"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          minWidth: '110px',
          border: 'none',
          padding: 0,
          margin: 0,
        }}
      >
        <legend
          style={{ fontSize: '0.75em', fontWeight: 600, textTransform: 'uppercase', opacity: 0.6 }}
        >
          Pieces
        </legend>
        {PIECE_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => addPiece(type)}
            style={{
              padding: '0.4rem 0.6rem',
              fontSize: '0.85em',
              cursor: 'pointer',
              background: 'var(--tf-color-surface, #f5f5f5)',
              border: `2px solid ${PIECE_FILL[type]}`,
              borderRadius: '4px',
              textAlign: 'left',
            }}
            aria-label={`Add ${PIECE_LABELS[type]}`}
          >
            {PIECE_LABELS[type]}
          </button>
        ))}
      </fieldset>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {/* Action bar */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            onClick={rotateSelected}
            disabled={selectedPiece === null}
            title="Rotate selected piece 45° (R)"
            aria-label="Rotate selected piece"
          >
            Rotate (R)
          </button>
          <button
            type="button"
            onClick={toggleTagSelected}
            disabled={selectedPiece === null}
            title="Toggle RFID tag on selected piece (T)"
            aria-label="Toggle tag"
          >
            {selectedPiece?.tagged ? 'Untag (T)' : 'Tag (T)'}
          </button>
          <button
            type="button"
            onClick={deleteSelected}
            disabled={selectedPiece === null}
            title="Delete selected piece (Delete)"
            aria-label="Delete selected piece"
          >
            Delete (Del)
          </button>
          <span style={{ marginLeft: 'auto', fontSize: '0.8em', opacity: 0.7 }}>
            {selectedPiece !== null
              ? `Selected: ${PIECE_LABELS[selectedPiece.type]} · ${selectedPiece.rotationDeg}°${selectedPiece.tagged ? ' · tagged' : ''}`
              : 'Click a piece to select'}
          </span>
        </div>

        {/* Canvas */}
        <svg
          width={CANVAS_W_MM * SCALE}
          height={CANVAS_H_MM * SCALE}
          viewBox={`0 0 ${CANVAS_W_MM} ${CANVAS_H_MM}`}
          style={{ border: '1px solid #ccc', background: '#fafafa', cursor: 'default' }}
          onClick={() => setSelectedId(null)}
          onKeyDown={handleCanvasKeyDown}
          aria-label="Track canvas"
          role="img"
          data-testid="track-canvas"
        >
          {pieces.map((p) => (
            <PieceRenderer
              key={p.id}
              piece={p}
              selected={p.id === selectedId}
              onSelect={() => setSelectedId(p.id)}
            />
          ))}
          {/* Endpoint connection dots rendered in world space above all pieces */}
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
        </svg>

        {/* Apply row */}
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor={layoutNameId} style={{ fontSize: '0.9em' }}>
            Layout name
          </label>
          <input
            id={layoutNameId}
            type="text"
            value={layoutName}
            onChange={(e) => setLayoutName(e.target.value)}
            style={{ padding: '0.3rem 0.5rem' }}
          />
          <button
            type="button"
            onClick={handleApply}
            data-testid="apply-layout-btn"
            aria-label="Apply layout"
          >
            Apply layout
          </button>
          <span style={{ fontSize: '0.8em', opacity: 0.7 }} data-testid="layout-stats">
            {markerCount} markers · {edgeCount} edges
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PieceRenderer
// ---------------------------------------------------------------------------

interface PieceRendererProps {
  readonly piece: TrackPiece;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function PieceRenderer({ piece, selected, onSelect }: PieceRendererProps) {
  const shape = getPieceShape(piece);
  const fill = PIECE_FILL[piece.type];

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    onSelect();
  }

  const { x, y } = piece.position;
  const { rotationDeg } = piece;

  return (
    <g
      transform={`translate(${x}, ${y}) rotate(${rotationDeg})`}
      onClick={handleClick}
      style={{ cursor: 'pointer' }}
      data-testid={`piece-${piece.id}`}
      aria-label={`${piece.type} piece`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {/* Selection halo */}
      {selected && (
        <path d={shape.svgPath} fill="none" stroke="#2563eb" strokeWidth={6} strokeOpacity={0.4} />
      )}
      {/* Piece body */}
      <path d={shape.svgPath} fill={fill} stroke="#333" strokeWidth={1.5} />
      {/* RFID tag badge */}
      {piece.tagged && (
        <g transform={`translate(0, ${-shape.height / 2 - 8})`}>
          <rect
            x={-8}
            y={-6}
            width={16}
            height={12}
            rx={2}
            fill="#f59e0b"
            stroke="#92400e"
            strokeWidth={1}
          />
          <text
            fontSize={8}
            textAnchor="middle"
            dy="4"
            fill="#92400e"
            style={{ fontFamily: 'monospace' }}
          >
            NFC
          </text>
        </g>
      )}
    </g>
  );
}
