import { useEffect, useMemo, useState } from 'react';
import { BrokerProvider } from './broker/broker-context.js';
import type { BrokerClient } from './broker/client.js';
import { MqttBrokerClient } from './broker/mqtt-client.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { LayoutConfig } from './components/LayoutConfig.js';
import { Settings } from './components/Settings.js';
import { SimControls } from './components/SimControls.js';
import { loadBrokerUrl } from './config/broker-config.js';
import {
  type StoredLayoutSelection,
  loadLayoutSelection,
  resolveLayout,
} from './config/layout-config.js';

interface AppProps {
  client?: BrokerClient;
}

export function App({ client }: AppProps = {}) {
  const resolvedClient = useMemo(() => client ?? new MqttBrokerClient(), [client]);
  const [initialUrl] = useState(loadBrokerUrl);
  const [layoutSelection, setLayoutSelection] =
    useState<StoredLayoutSelection>(loadLayoutSelection);
  const layout = useMemo(() => resolveLayout(layoutSelection), [layoutSelection]);

  useEffect(() => {
    resolvedClient.connect(initialUrl);
    return () => resolvedClient.disconnect();
  }, [resolvedClient, initialUrl]);

  return (
    <BrokerProvider client={resolvedClient}>
      <main>
        <h1>Trainframe Simulator</h1>
        <p>
          Configure the layout, run the simulation, and publish events to your Trainframe broker.
        </p>
        <ConnectionStatus />
        <Settings initialUrl={initialUrl} />
        <LayoutConfig selection={layoutSelection} onChange={setLayoutSelection} />
        <SimControls layout={layout} />
      </main>
    </BrokerProvider>
  );
}
