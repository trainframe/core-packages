import { useEffect, useRef, useState } from 'react';

const DATA_MIME = 'application/x-trainframe-piece';

export interface ScanBoxProps {
  /**
   * Called with a piece ID after a drop to retrieve the human-readable
   * description to show in the confirmation panel. Returns `undefined` when
   * the piece is not found (the drop is ignored).
   */
  readonly describePiece: (pieceId: string) => { typeLabel: string; bindingId: string } | undefined;
  /**
   * Called when the operator clicks **Bind** (or presses Enter) to confirm
   * the scan. Only fires after the operator explicitly confirms; dropping
   * alone does not fire any bus events.
   */
  readonly onConfirm: (pieceId: string) => void;
}

interface PendingScan {
  readonly pieceId: string;
  readonly typeLabel: string;
  readonly bindingId: string;
}

/**
 * Drop zone that "scans" a placed piece onto the bus. Dragging a piece
 * out of the toy-table canvas and releasing it over the scan box first
 * shows a confirmation panel — the operator sees what was scanned and
 * can Bind or Cancel. Only on Bind does the broker events fire via
 * `onConfirm`. This keeps the "placement publishes nothing" invariant:
 * a piece is inert until the operator explicitly commits it.
 *
 * Keyboard: Enter confirms Bind, Escape cancels.
 */
export function ScanBox({ describePiece, onConfirm }: ScanBoxProps) {
  const [highlight, setHighlight] = useState(false);
  const [pending, setPending] = useState<PendingScan | null>(null);
  const bindButtonRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the Bind button when the confirmation panel appears so
  // Enter confirms natively without extra keyboard wiring.
  useEffect(() => {
    if (pending !== null) {
      bindButtonRef.current?.focus();
    }
  }, [pending]);

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
    const description = describePiece(pieceId);
    if (description === undefined) return;
    setPending({ pieceId, ...description });
  }

  function handleBind() {
    if (pending === null) return;
    const { pieceId } = pending;
    setPending(null);
    onConfirm(pieceId);
  }

  function handleCancel() {
    setPending(null);
  }

  // Escape cancels, but only when the confirmation panel is visible — don't
  // intercept Escape when idle (ToyTable's own Escape clears selection).
  function handleKeyDown(e: React.KeyboardEvent) {
    if (pending === null) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      handleCancel();
    }
  }

  if (pending !== null) {
    return (
      <div
        className="tf-scanbox tf-scanbox--confirming"
        data-testid="scan-box"
        aria-label="Scan box — confirm binding"
        onKeyDown={handleKeyDown}
      >
        <p className="tf-scanbox__confirm-label">
          Scanned a <strong>{pending.typeLabel}</strong>
        </p>
        <p className="tf-scanbox__confirm-id">Bind as {pending.bindingId}?</p>
        <div className="tf-scanbox__confirm-actions">
          <button
            ref={bindButtonRef}
            type="button"
            className="tf-scanbox__bind"
            onClick={handleBind}
            data-testid="scan-box-bind"
          >
            Bind
          </button>
          <button
            type="button"
            className="tf-scanbox__cancel"
            onClick={handleCancel}
            data-testid="scan-box-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    );
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
