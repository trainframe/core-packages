import { useEffect, useMemo, useState } from 'react';
import { BrokerProvider } from './broker/broker-context.js';
import type { BrokerSubscriber } from './broker/client.js';
import { MqttBrokerSubscriber } from './broker/mqtt-client.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { DeadlockBanner } from './components/DeadlockBanner.js';
import { DevicesPanel } from './components/DevicesPanel.js';
import { EventLog } from './components/EventLog.js';
import { LayoutCanvas } from './components/LayoutCanvas.js';
import { ScheduleAssigner } from './components/ScheduleAssigner.js';
import { ScheduleList } from './components/ScheduleList.js';
import { Settings } from './components/Settings.js';
import { UnknownTags } from './components/UnknownTags.js';
import { loadAdminApiUrl } from './config/admin-api-config.js';
import { loadBrokerUrl } from './config/broker-config.js';

interface AppProps {
  client?: BrokerSubscriber;
}

export function App({ client }: AppProps = {}) {
  const resolvedClient = useMemo(() => client ?? new MqttBrokerSubscriber(), [client]);
  const [initialUrl] = useState(loadBrokerUrl);
  const [adminApiUrl] = useState(loadAdminApiUrl);

  useEffect(() => {
    resolvedClient.connect(initialUrl);
    return () => resolvedClient.disconnect();
  }, [resolvedClient, initialUrl]);

  return (
    <BrokerProvider client={resolvedClient}>
      <main>
        <h1>Trainframe Visualiser</h1>
        <ConnectionStatus />
        <Settings initialUrl={initialUrl} />
        <DeadlockBanner />
        <ScheduleList />
        <ScheduleAssigner />
        <DevicesPanel />
        <LayoutCanvas />
        <UnknownTags adminApiUrl={adminApiUrl} />
        <EventLog />
      </main>
    </BrokerProvider>
  );
}
