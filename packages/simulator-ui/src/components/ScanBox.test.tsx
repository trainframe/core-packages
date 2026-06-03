import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SCANBOX_DATA_MIME, ScanBox } from './ScanBox.js';

describe('ScanBox', () => {
  it('renders a drop target with an explanatory label', () => {
    render(<ScanBox onDrop={() => {}} />);
    const box = screen.getByTestId('scan-box');
    expect(box).toHaveTextContent(/drop a piece here/i);
  });

  it('invokes onDrop with the piece id pulled from the drag data', () => {
    const onDrop = vi.fn();
    render(<ScanBox onDrop={onDrop} />);
    const box = screen.getByTestId('scan-box');

    fireEvent.dragOver(box, {
      dataTransfer: { dropEffect: 'move', getData: () => '', setData: () => {} },
    });
    expect(box.className).toMatch(/--hot/);

    fireEvent.drop(box, {
      dataTransfer: {
        getData: (mime: string) => (mime === SCANBOX_DATA_MIME ? 'piece-42' : ''),
      },
    });
    expect(onDrop).toHaveBeenCalledWith('piece-42');
    expect(box.className).not.toMatch(/--hot/);
  });

  it('ignores a drop that carries no recognised piece id', () => {
    const onDrop = vi.fn();
    render(<ScanBox onDrop={onDrop} />);

    fireEvent.drop(screen.getByTestId('scan-box'), {
      dataTransfer: { getData: () => '' },
    });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('clears the highlight when the drag leaves', () => {
    render(<ScanBox onDrop={() => {}} />);
    const box = screen.getByTestId('scan-box');

    fireEvent.dragOver(box, {
      dataTransfer: { dropEffect: 'move', getData: () => '', setData: () => {} },
    });
    expect(box.className).toMatch(/--hot/);

    fireEvent.dragLeave(box);
    expect(box.className).not.toMatch(/--hot/);
  });
});
