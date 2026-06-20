import { Button } from '@trainframe/ui-kit';
import { useState } from 'react';
import './ConfirmButton.css';

interface ConfirmButtonProps {
  readonly label: string;
  readonly confirmLabel?: string;
  /* When set, the confirm step is gated on typing this exact phrase. */
  readonly requirePhrase?: string;
  readonly onConfirm: () => void | Promise<void>;
  readonly variant?: 'secondary' | 'danger';
  readonly disabled?: boolean;
}

/**
 * Destructive action with an inline confirm step — no modal. First click arms
 * it; a second click (optionally gated on a typed phrase) fires onConfirm.
 * Clicking Cancel resets it.
 */
export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  requirePhrase,
  onConfirm,
  variant = 'danger',
  disabled = false,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const [phrase, setPhrase] = useState('');

  if (!armed) {
    return (
      <Button variant={variant} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }

  const phraseOk = requirePhrase === undefined || phrase === requirePhrase;
  return (
    <span className="tf-confirm">
      {requirePhrase !== undefined && (
        <input
          className="tf-confirm__phrase"
          type="text"
          aria-label={`Type ${requirePhrase} to confirm`}
          placeholder={requirePhrase}
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
        />
      )}
      <Button
        variant={variant}
        disabled={!phraseOk}
        onClick={() => {
          setArmed(false);
          setPhrase('');
          void onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button
        variant="secondary"
        onClick={() => {
          setArmed(false);
          setPhrase('');
        }}
      >
        Cancel
      </Button>
    </span>
  );
}
