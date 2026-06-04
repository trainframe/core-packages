import { useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import { saveBrokerUrl } from '../config/broker-config.js';

interface SettingsProps {
  initialUrl: string;
}

/**
 * Broker-URL settings form for the simulator-ui. Mirrors the visualiser's
 * `Settings` component so the operator can type a new broker URL and
 * reconnect. Shows a `role="alert"` with a human-readable message when the
 * broker connection fails.
 *
 * Re-adds a settings surface that was retired alongside the old
 * SimControls/LayoutConfig developer panel (see App.tsx). That retirement
 * was correct — the scheduling controls don't belong here. The settings
 * surface does: the operator-facing "broker URL is wrong, fix it" need
 * exists regardless of architecture.
 */
export function Settings({ initialUrl }: SettingsProps) {
  const { client, status, error } = useBroker();
  const [url, setUrl] = useState(initialUrl);
  const [savedUrl, setSavedUrl] = useState(initialUrl);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveBrokerUrl(url);
    setSavedUrl(url);
    client.connect(url);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Broker settings">
      <label>
        <span>Broker URL</span>
        <input
          type="url"
          name="brokerUrl"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="ws://localhost:9001"
          required
        />
      </label>
      <button type="submit">Connect</button>
      <p>
        Currently configured: <code>{savedUrl}</code>
      </p>
      {status === 'error' && (
        <p role="alert" data-testid="broker-error">
          {error?.message ?? "Couldn't reach the broker — check the URL."}
        </p>
      )}
    </form>
  );
}
