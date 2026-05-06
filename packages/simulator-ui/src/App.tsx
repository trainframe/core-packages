import { useEffect, useMemo, useState } from 'react';
import { BrokerProvider } from './broker/broker-context.js';
import type { BrokerClient } from './broker/client.js';
import { MqttBrokerClient } from './broker/mqtt-client.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { Settings } from './components/Settings.js';
import { loadBrokerUrl } from './config/broker-config.js';

interface AppProps {
  client?: BrokerClient;
}

export function App({ client }: AppProps = {}) {
  const resolvedClient = useMemo(() => client ?? new MqttBrokerClient(), [client]);
  const [initialUrl] = useState(loadBrokerUrl);

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
          Track configuration and physical-mishap modelling are next on the build list.
        </p>
        <ConnectionStatus />
        <Settings initialUrl={initialUrl} />
      </main>
    </BrokerProvider>
  );
}
