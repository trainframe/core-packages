import { Panel } from '@trainframe/ui-kit';
import { useState } from 'react';
import { pruneMarkers, resetState } from '../api/admin-client.js';
import { ConfirmButton } from './ConfirmButton.js';
import './MaintenancePanel.css';

/**
 * Destructive maintenance actions, fenced off as a "danger zone". Prune sweeps
 * up orphaned (zero-edge) markers; Blank slate forgets the entire railway and
 * is gated on a typed phrase.
 */
export function MaintenancePanel({ adminApiUrl }: { readonly adminApiUrl: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<string>) => () => {
    setError(null);
    setMessage(null);
    action()
      .then(setMessage)
      .catch((err) => setError(err instanceof Error ? err.message : 'request failed'));
  };

  return (
    <Panel label="Maintenance" className="tf-maintenance" data-testid="maintenance-panel">
      <p className="tf-maintenance__hint">Destructive — these forget state and cannot be undone.</p>
      <div className="tf-maintenance__actions">
        <ConfirmButton
          label="Prune orphaned markers"
          confirmLabel="Confirm prune"
          variant="secondary"
          onConfirm={run(async () => {
            const pruned = await pruneMarkers(adminApiUrl);
            return pruned.length === 0 ? 'Nothing to prune.' : `Pruned ${pruned.length} marker(s).`;
          })}
        />
        <ConfirmButton
          label="Blank slate"
          confirmLabel="Confirm blank slate"
          requirePhrase="RESET"
          variant="danger"
          onConfirm={run(async () => {
            const { topics_cleared } = await resetState(adminApiUrl);
            return `Blank slate done — cleared ${topics_cleared} retained topic(s).`;
          })}
        />
      </div>
      {message && <output className="tf-maintenance__message">{message}</output>}
      {error && (
        <p className="tf-maintenance__error" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}
