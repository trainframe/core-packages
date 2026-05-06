import { useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import { saveBrokerUrl } from '../config/broker-config.js';

interface SettingsProps {
  initialUrl: string;
}

export function Settings({ initialUrl }: SettingsProps) {
  const { client } = useBroker();
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
    </form>
  );
}
