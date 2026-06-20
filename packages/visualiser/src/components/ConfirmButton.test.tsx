import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from './ConfirmButton.js';

describe('ConfirmButton', () => {
  it('requires a second click before firing onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Delete" onConfirm={onConfirm} variant="danger" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('gates on a typed phrase when requirePhrase is set', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        label="Blank slate"
        requirePhrase="RESET"
        onConfirm={onConfirm}
        variant="danger"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Blank slate' }));
    const confirm = screen.getByRole('button', { name: /confirm/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'RESET' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
