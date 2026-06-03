import { useState } from 'react';

const DATA_MIME = 'application/x-trainframe-piece';

export interface ScanBoxProps {
  /** Called with the dropped piece's ID. */
  readonly onDrop: (pieceId: string) => void;
}

/**
 * Drop zone that "scans" a placed piece onto the bus. Dragging a piece
 * out of the toy-table canvas and releasing it over the scan box fires
 * the piece's identifying broker event(s) via `onDrop`. Inert pieces left
 * untouched on the table emit nothing — only a drop here lights them up.
 *
 * The scan logic itself lives in `ToyTable`; this component handles only
 * the DOM glue (dragover / drop) and the visual highlight.
 */
export function ScanBox({ onDrop }: ScanBoxProps) {
  const [highlight, setHighlight] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setHighlight(true);
  }

  function handleDragLeave() {
    setHighlight(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setHighlight(false);
    const pieceId = e.dataTransfer.getData(DATA_MIME);
    if (pieceId === '') return;
    onDrop(pieceId);
  }

  return (
    <div
      className={`tf-scanbox${highlight ? ' tf-scanbox--hot' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="scan-box"
      aria-label="Scan box"
    >
      <span className="tf-scanbox__icon" aria-hidden="true">
        ⌖
      </span>
      <span className="tf-scanbox__label">Drop a piece here to scan it onto the bus</span>
    </div>
  );
}

export { DATA_MIME as SCANBOX_DATA_MIME };
