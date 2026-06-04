import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SCANBOX_DATA_MIME, ScanBox } from './ScanBox.js';

const MOCK_PIECE_ID = 'straight-1';
const MOCK_DESCRIPTION = { typeLabel: 'Straight', bindingId: 'M-straight-1' };

/** Default describePiece stub that always returns a description for MOCK_PIECE_ID. */
function makeDescribePiece(
  pieceId = MOCK_PIECE_ID,
  description = MOCK_DESCRIPTION,
): (id: string) => { typeLabel: string; bindingId: string } | undefined {
  return (id) => (id === pieceId ? description : undefined);
}

/** Fire a drop on the scan box with the given piece id. */
function dropOnScanBox(scanBox: HTMLElement, pieceId: string): void {
  fireEvent.drop(scanBox, {
    dataTransfer: {
      getData: (mime: string) => (mime === SCANBOX_DATA_MIME ? pieceId : ''),
    },
  });
}

describe('ScanBox — idle state', () => {
  it('renders a drop target with an explanatory label', () => {
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={() => {}} />);
    const box = screen.getByTestId('scan-box');
    expect(box).toHaveTextContent(/drop a piece here/i);
  });

  it('highlights on dragover and clears on dragleave', () => {
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={() => {}} />);
    const box = screen.getByTestId('scan-box');

    fireEvent.dragOver(box, {
      dataTransfer: { dropEffect: 'move', getData: () => '', setData: () => {} },
    });
    expect(box.className).toMatch(/--hot/);

    fireEvent.dragLeave(box);
    expect(box.className).not.toMatch(/--hot/);
  });

  it('ignores a drop that carries no recognised piece id', () => {
    const onConfirm = vi.fn();
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={onConfirm} />);

    fireEvent.drop(screen.getByTestId('scan-box'), {
      dataTransfer: { getData: () => '' },
    });
    expect(onConfirm).not.toHaveBeenCalled();
    // No confirmation panel should appear.
    expect(screen.queryByTestId('scan-box-bind')).toBeNull();
  });

  it('ignores a drop for a piece the describePiece function cannot find', () => {
    const onConfirm = vi.fn();
    // describePiece always returns undefined.
    render(<ScanBox describePiece={() => undefined} onConfirm={onConfirm} />);

    dropOnScanBox(screen.getByTestId('scan-box'), 'unknown-piece');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('scan-box-bind')).toBeNull();
  });
});

describe('ScanBox — confirmation panel', () => {
  it('drop shows confirmation panel with piece type and binding id', () => {
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={() => {}} />);
    const box = screen.getByTestId('scan-box');

    dropOnScanBox(box, MOCK_PIECE_ID);

    expect(screen.getByTestId('scan-box-bind')).toBeInTheDocument();
    expect(screen.getByTestId('scan-box-cancel')).toBeInTheDocument();
    expect(box).toHaveTextContent(/Straight/);
    expect(box).toHaveTextContent(/M-straight-1/);
  });

  it('drop does NOT call onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={onConfirm} />);

    dropOnScanBox(screen.getByTestId('scan-box'), MOCK_PIECE_ID);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clicking Bind calls onConfirm with the piece id and resets to idle', () => {
    const onConfirm = vi.fn();
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={onConfirm} />);

    dropOnScanBox(screen.getByTestId('scan-box'), MOCK_PIECE_ID);
    fireEvent.click(screen.getByTestId('scan-box-bind'));

    expect(onConfirm).toHaveBeenCalledWith(MOCK_PIECE_ID);
    // Confirmation panel should disappear.
    expect(screen.queryByTestId('scan-box-bind')).toBeNull();
    // Idle drop-target label returns.
    expect(screen.getByTestId('scan-box')).toHaveTextContent(/drop a piece here/i);
  });

  it('clicking Cancel does NOT call onConfirm and resets to idle', () => {
    const onConfirm = vi.fn();
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={onConfirm} />);

    dropOnScanBox(screen.getByTestId('scan-box'), MOCK_PIECE_ID);
    fireEvent.click(screen.getByTestId('scan-box-cancel'));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('scan-box-bind')).toBeNull();
    expect(screen.getByTestId('scan-box')).toHaveTextContent(/drop a piece here/i);
  });

  it('pressing Escape cancels without calling onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={onConfirm} />);

    dropOnScanBox(screen.getByTestId('scan-box'), MOCK_PIECE_ID);

    act(() => {
      fireEvent.keyDown(screen.getByTestId('scan-box'), { key: 'Escape' });
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('scan-box-bind')).toBeNull();
  });

  it('highlight clears when a drop arrives (not left --hot while confirming)', () => {
    render(<ScanBox describePiece={makeDescribePiece()} onConfirm={() => {}} />);
    const box = screen.getByTestId('scan-box');

    fireEvent.dragOver(box, {
      dataTransfer: { dropEffect: 'move', getData: () => '', setData: () => {} },
    });
    expect(box.className).toMatch(/--hot/);

    dropOnScanBox(box, MOCK_PIECE_ID);
    // After drop → confirming state, hot class should be gone.
    expect(screen.getByTestId('scan-box').className).not.toMatch(/--hot/);
  });
});
