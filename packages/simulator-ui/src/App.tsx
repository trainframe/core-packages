import { useEffect, useMemo, useState } from 'react';
import { BrokerProvider } from './broker/broker-context.js';
import type { BrokerClient } from './broker/client.js';
import { MqttBrokerClient } from './broker/mqtt-client.js';
import { Settings } from './components/Settings.js';
import { ToyTable } from './components/ToyTable.js';
import './components/ToyTable.css';
import { loadBrokerUrl } from './config/broker-config.js';

interface AppProps {
  client?: BrokerClient;
}

/**
 * Trainframe simulator UI — the operator-facing "toy table" of virtual
 * hardware. The previous developer panel (SimControls / LayoutConfig /
 * Settings) has been retired; everything lives inside `<ToyTable />` now.
 *
 * `<Settings>` is kept as a separate component outside `<ToyTable>` so the
 * operator can reconfigure the broker URL without touching the canvas state.
 */
export function App({ client }: AppProps = {}) {
  const resolvedClient = useMemo(() => client ?? new MqttBrokerClient(), [client]);
  const [initialUrl] = useState(loadBrokerUrl);

  useEffect(() => {
    resolvedClient.connect(initialUrl);
    return () => resolvedClient.disconnect();
  }, [resolvedClient, initialUrl]);

  return (
    <BrokerProvider client={resolvedClient}>
      <Settings initialUrl={initialUrl} />
      <ToyTable />
    </BrokerProvider>
  );
}
