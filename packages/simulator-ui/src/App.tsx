import { useEffect, useMemo } from 'react';
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
 */
export function App({ client }: AppProps = {}) {
  const resolvedClient = useMemo(() => client ?? new MqttBrokerClient(), [client]);

  useEffect(() => {
    resolvedClient.connect(loadBrokerUrl());
    return () => resolvedClient.disconnect();
  }, [resolvedClient]);

  return (
    <BrokerProvider client={resolvedClient}>
      <ToyTable />
    </BrokerProvider>
  );
}
