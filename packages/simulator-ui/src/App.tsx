import { useEffect, useMemo, useState } from 'react';
import { BrokerProvider } from './broker/broker-context.js';
import type { BrokerClient } from './broker/client.js';
import { MqttBrokerClient } from './broker/mqtt-client.js';
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
 * The broker-URL settings are tucked behind a cog icon in the ToyTable
 * header so the toy-table framing is preserved while the operator can still
 * reach them when needed. `initialUrl` is threaded down to ToyTable so the
 * Settings form knows its starting value.
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
      <ToyTable initialUrl={initialUrl} />
    </BrokerProvider>
  );
}
